package envguardcore

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type GeoSource struct {
	Source      string  `json:"source"`
	IP          string  `json:"ip"`
	CountryCode string  `json:"countryCode"`
	City        *string `json:"city"`
	RegionName  *string `json:"regionName"`
	Timezone    *string `json:"timezone"`
	ASN         *string `json:"asn"`
	Org         *string `json:"org"`
}

type ProbeResult struct {
	Status    *int   `json:"status"`
	Error     string `json:"error,omitempty"`
	ElapsedMs int64  `json:"elapsedMs"`
}

type EdgeTrace struct {
	Colo  *string `json:"colo"`
	Loc   *string `json:"loc"`
	City  *string `json:"city"`
	HTTP  *int    `json:"http"`
	Error *string `json:"error"`
}

var unsupportedClaudeCountries = map[string]bool{
	"CN": true, "HK": true, "MO": true, "RU": true, "BY": true,
	"IR": true, "KP": true, "SY": true, "CU": true, "AF": true,
}

func isClaudeSupportedCountry(code string) bool {
	c := strings.ToUpper(strings.TrimSpace(code))
	if c == "" {
		return false
	}
	return !unsupportedClaudeCountries[c]
}

func proxyHTTPClient(proxyAddr string, timeout time.Duration) *http.Client {
	transport := &http.Transport{
		DisableKeepAlives: true,
	}
	if proxyAddr != "" {
		if u, err := url.Parse(proxyAddr); err == nil {
			transport.Proxy = http.ProxyURL(u)
		}
	}
	return &http.Client{
		Transport: transport,
		Timeout:   timeout,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func probeHTTP(ctx context.Context, client *http.Client, targetURL string) ProbeResult {
	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodHead, targetURL, nil)
	if err != nil {
		return ProbeResult{Error: err.Error(), ElapsedMs: time.Since(start).Milliseconds()}
	}
	req.Header.Set("User-Agent", "EnvGuardCC-Mobile-Probe")
	resp, err := client.Do(req)
	if err != nil {
		return ProbeResult{Error: err.Error(), ElapsedMs: time.Since(start).Milliseconds()}
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
	status := resp.StatusCode
	return ProbeResult{
		Status:    &status,
		ElapsedMs: time.Since(start).Milliseconds(),
	}
}

func probeCloudflareTrace(ctx context.Context, client *http.Client) *EdgeTrace {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, "https://claude.ai/cdn-cgi/trace", nil)
	if err != nil {
		msg := err.Error()
		return &EdgeTrace{Error: &msg}
	}
	resp, err := client.Do(req)
	if err != nil {
		msg := err.Error()
		return &EdgeTrace{Error: &msg}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 16*1024))
	if err != nil {
		msg := err.Error()
		return &EdgeTrace{Error: &msg}
	}
	code := resp.StatusCode
	trace := &EdgeTrace{HTTP: &code}
	for _, line := range strings.Split(string(body), "\n") {
		kv := strings.SplitN(strings.TrimSpace(line), "=", 2)
		if len(kv) != 2 {
			continue
		}
		v := kv[1]
		switch kv[0] {
		case "colo":
			trace.Colo = &v
		case "loc":
			trace.Loc = &v
		}
	}
	return trace
}

func probeGeoSources(ctx context.Context, client *http.Client) []GeoSource {
	var wg sync.WaitGroup
	var mu sync.Mutex
	out := make([]GeoSource, 0, 2)

	fetchJSON := func(name, endpoint string, parse func(map[string]any) *GeoSource) {
		defer wg.Done()
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
		if err != nil {
			return
		}
		req.Header.Set("Accept", "application/json")
		resp, err := client.Do(req)
		if err != nil {
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusOK {
			return
		}
		var doc map[string]any
		if err := json.NewDecoder(io.LimitReader(resp.Body, 64*1024)).Decode(&doc); err != nil {
			return
		}
		if src := parse(doc); src != nil {
			mu.Lock()
			out = append(out, *src)
			mu.Unlock()
		}
	}

	wg.Add(2)
	go fetchJSON("ipwho.is", "https://ipwho.is/", func(m map[string]any) *GeoSource {
		ip, _ := m["ip"].(string)
		cc, _ := m["country_code"].(string)
		if ip == "" || cc == "" {
			return nil
		}
		src := &GeoSource{Source: "ipwho.is", IP: ip, CountryCode: strings.ToUpper(cc)}
		if city, _ := m["city"].(string); city != "" {
			src.City = &city
		}
		if reg, _ := m["region"].(string); reg != "" {
			src.RegionName = &reg
		}
		if tzObj, ok := m["timezone"].(map[string]any); ok {
			if id, _ := tzObj["id"].(string); id != "" {
				src.Timezone = &id
			}
		}
		if conn, ok := m["connection"].(map[string]any); ok {
			if asnNum, ok := toInt(conn["asn"]); ok && asnNum > 0 {
				s := fmt.Sprintf("AS%d", asnNum)
				src.ASN = &s
			}
			if org, _ := conn["org"].(string); org != "" {
				src.Org = &org
			} else if isp, _ := conn["isp"].(string); isp != "" {
				src.Org = &isp
			}
		}
		return src
	})
	go fetchJSON("ipapi.co", "https://ipapi.co/json/", func(m map[string]any) *GeoSource {
		ip, _ := m["ip"].(string)
		cc, _ := m["country_code"].(string)
		if ip == "" || cc == "" {
			return nil
		}
		src := &GeoSource{Source: "ipapi.co", IP: ip, CountryCode: strings.ToUpper(cc)}
		if city, _ := m["city"].(string); city != "" {
			src.City = &city
		}
		if reg, _ := m["region"].(string); reg != "" {
			src.RegionName = &reg
		}
		if tz, _ := m["timezone"].(string); tz != "" {
			src.Timezone = &tz
		}
		if asn, _ := m["asn"].(string); asn != "" {
			src.ASN = &asn
		}
		if org, _ := m["org"].(string); org != "" {
			src.Org = &org
		}
		return src
	})
	wg.Wait()
	return out
}

func targetForCountry(cc string) (language, locale string) {
	switch strings.ToUpper(cc) {
	case "JP":
		return "ja-JP", "ja-JP"
	case "KR":
		return "ko-KR", "ko-KR"
	case "GB":
		return "en-GB", "en-GB"
	case "DE":
		return "de-DE", "de-DE"
	case "FR":
		return "fr-FR", "fr-FR"
	case "SG":
		return "en-SG", "en-SG"
	case "TW":
		return "zh-TW", "zh-TW"
	case "AU":
		return "en-AU", "en-AU"
	case "CA":
		return "en-CA", "en-CA"
	default:
		return "en-US", "en-US"
	}
}
