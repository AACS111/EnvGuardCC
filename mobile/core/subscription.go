package envguardcore

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

// ProxyNode represents a normalized mihomo proxy entry.
type ProxyNode map[string]any

// SourceRecord mirrors scripts/net-core/sources.mjs for multi-subscription management.
type SourceRecord struct {
	ID            string      `json:"id"`
	Name          string      `json:"name"`
	Mode          string      `json:"mode"` // url | content | manual
	URL           string      `json:"url,omitempty"`
	Proxies       []ProxyNode `json:"proxies"`
	Selected      string      `json:"selected"`
	UpdatedAt     string      `json:"updatedAt"`
	IntervalHours int         `json:"intervalHours"`
}

// SourceStore holds all user-configured node sources on disk.
type SourceStore struct {
	Version  int            `json:"version"`
	ActiveID string         `json:"activeId"`
	Sources  []SourceRecord `json:"sources"`
}

// PublicSource is the sanitized view returned to the UI.
type PublicSource struct {
	ID            string  `json:"id"`
	Name          string  `json:"name"`
	Mode          string  `json:"mode"`
	URL           *string `json:"url"`
	NodeCount     int     `json:"nodeCount"`
	Selected      *string `json:"selected"`
	UpdatedAt     string  `json:"updatedAt"`
	IntervalHours int     `json:"intervalHours"`
	Active        bool    `json:"active"`
}

func loadSourceStore(stateDir string) *SourceStore {
	path := filepath.Join(stateDir, "net-core-sources.json")
	raw, err := os.ReadFile(path)
	if err != nil {
		return &SourceStore{Version: 2, Sources: []SourceRecord{}}
	}
	var store SourceStore
	if err := json.Unmarshal(raw, &store); err != nil {
		return &SourceStore{Version: 2, Sources: []SourceRecord{}}
	}
	if store.Version == 0 {
		store.Version = 2
	}
	return &store
}

func saveSourceStore(stateDir string, store *SourceStore) error {
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return err
	}
	raw, err := json.MarshalIndent(store, "", "  ")
	if err != nil {
		return err
	}
	path := filepath.Join(stateDir, "net-core-sources.json")
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func (s *SourceStore) Active() *SourceRecord {
	for i := range s.Sources {
		if s.Sources[i].ID == s.ActiveID {
			return &s.Sources[i]
		}
	}
	if len(s.Sources) > 0 {
		s.ActiveID = s.Sources[0].ID
		return &s.Sources[0]
	}
	return nil
}

func (s *SourceStore) Public() []PublicSource {
	out := make([]PublicSource, 0, len(s.Sources))
	for _, src := range s.Sources {
		var u *string
		if src.URL != "" {
			v := src.URL
			u = &v
		}
		var sel *string
		if src.Selected != "" {
			v := src.Selected
			sel = &v
		}
		out = append(out, PublicSource{
			ID:            src.ID,
			Name:          src.Name,
			Mode:          src.Mode,
			URL:           u,
			NodeCount:     len(src.Proxies),
			Selected:      sel,
			UpdatedAt:     src.UpdatedAt,
			IntervalHours: src.IntervalHours,
			Active:        src.ID == s.ActiveID,
		})
	}
	return out
}

func proxyName(p ProxyNode) string {
	if p == nil {
		return ""
	}
	if name, ok := p["name"].(string); ok {
		return strings.TrimSpace(name)
	}
	return ""
}

func fetchSubscriptionURL(rawURL string, client *http.Client) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", errors.New("订阅地址必须是有效的 http/https URL。")
	}
	if client == nil {
		client = &http.Client{Timeout: 25 * time.Second}
	}
	req, err := http.NewRequest(http.MethodGet, parsed.String(), nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("User-Agent", "clash.meta/1.19.33 EnvGuardCC-Mobile")
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("拉取订阅失败：%w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return "", fmt.Errorf("订阅返回 HTTP %d", resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 8*1024*1024))
	if err != nil {
		return "", err
	}
	return string(body), nil
}

// ParseSubscription parses Clash/Mihomo YAML, Base64-encoded URI lists, or plain proxy URIs.
func ParseSubscription(content string) ([]ProxyNode, []map[string]any, error) {
	trimmed := strings.TrimSpace(content)
	if trimmed == "" {
		return nil, nil, errors.New("配置内容为空。")
	}

	// 1. Try Clash/Mihomo YAML with `proxies:` field.
	var doc map[string]any
	if err := yaml.Unmarshal([]byte(trimmed), &doc); err == nil && doc != nil {
		if rawList, ok := doc["proxies"].([]any); ok && len(rawList) > 0 {
			nodes, skipped := normalizeProxySlice(rawList)
			if len(nodes) > 0 {
				return nodes, skipped, nil
			}
		}
	}

	// 2. Try Base64 decoding if content has no scheme separators.
	text := trimmed
	if !strings.Contains(text, "://") {
		if decoded, ok := decodeBase64Flexible(text); ok && strings.Contains(decoded, "://") {
			text = decoded
		}
	}

	// 3. Parse line-by-line proxy URIs.
	lines := strings.Split(strings.ReplaceAll(text, "\r\n", "\n"), "\n")
	var nodes []ProxyNode
	var skipped []map[string]any
	usedNames := map[string]int{}
	for idx, rawLine := range lines {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		node, err := parseProxyURI(line)
		if err != nil {
			skipped = append(skipped, map[string]any{
				"index":  idx,
				"reason": err.Error(),
			})
			continue
		}
		name := uniqueName(proxyName(node), usedNames)
		node["name"] = name
		nodes = append(nodes, node)
	}
	if len(nodes) == 0 {
		return nil, skipped, errors.New("未解析到有效代理节点，请检查订阅格式（支持 Clash YAML 或 ss/vmess/vless/trojan/hysteria2/socks5 链接）。")
	}
	return nodes, skipped, nil
}

func normalizeProxySlice(rawList []any) ([]ProxyNode, []map[string]any) {
	var nodes []ProxyNode
	var skipped []map[string]any
	usedNames := map[string]int{}
	for idx, item := range rawList {
		m, ok := item.(map[string]any)
		if !ok {
			skipped = append(skipped, map[string]any{"index": idx, "reason": "节点格式不是对象"})
			continue
		}
		node := ProxyNode{}
		for k, v := range m {
			node[k] = v
		}
		name := proxyName(node)
		ptype, _ := node["type"].(string)
		server, _ := node["server"].(string)
		port, okPort := toInt(node["port"])
		if name == "" || strings.TrimSpace(ptype) == "" || strings.TrimSpace(server) == "" || !okPort || port < 1 || port > 65535 {
			skipped = append(skipped, map[string]any{"index": idx, "reason": "节点缺少 name/type/server 或端口无效"})
			continue
		}
		node["name"] = uniqueName(name, usedNames)
		node["port"] = port
		nodes = append(nodes, node)
	}
	return nodes, skipped
}

func uniqueName(base string, used map[string]int) string {
	base = strings.TrimSpace(base)
	if base == "" {
		base = "Node"
	}
	if count, exists := used[base]; exists {
		count++
		used[base] = count
		return fmt.Sprintf("%s #%d", base, count)
	}
	used[base] = 1
	return base
}

func toInt(v any) (int, bool) {
	switch n := v.(type) {
	case int:
		return n, true
	case int64:
		return int(n), true
	case float64:
		return int(n), true
	case string:
		parsed, err := strconv.Atoi(strings.TrimSpace(n))
		return parsed, err == nil
	default:
		return 0, false
	}
}

func decodeBase64Flexible(s string) (string, bool) {
	clean := strings.Map(func(r rune) rune {
		if r == '\r' || r == '\n' || r == ' ' || r == '\t' {
			return -1
		}
		return r
	}, s)
	for _, enc := range []*base64.Encoding{
		base64.StdEncoding,
		base64.RawStdEncoding,
		base64.URLEncoding,
		base64.RawURLEncoding,
	} {
		if b, err := enc.DecodeString(clean); err == nil && len(b) > 0 {
			return string(b), true
		}
	}
	return "", false
}

func parseProxyURI(line string) (ProxyNode, error) {
	lower := strings.ToLower(line)
	switch {
	case strings.HasPrefix(lower, "ss://"):
		return parseSSURI(line)
	case strings.HasPrefix(lower, "vmess://"):
		return parseVMessURI(line)
	case strings.HasPrefix(lower, "vless://"):
		return parseVLESSURI(line)
	case strings.HasPrefix(lower, "trojan://"):
		return parseTrojanURI(line)
	case strings.HasPrefix(lower, "hysteria2://"), strings.HasPrefix(lower, "hy2://"):
		return parseHysteria2URI(line)
	case strings.HasPrefix(lower, "socks5://"), strings.HasPrefix(lower, "socks://"):
		return parseBasicProxyURI(line, "socks5")
	case strings.HasPrefix(lower, "http://"), strings.HasPrefix(lower, "https://"):
		return parseBasicProxyURI(line, "http")
	default:
		return nil, errors.New("不支持的节点协议")
	}
}

func parseSSURI(raw string) (ProxyNode, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	name, _ := url.QueryUnescape(u.Fragment)
	if u.Host == "" {
		// Legacy ss://base64(method:password@host:port)#name
		body := strings.TrimPrefix(raw, "ss://")
		if idx := strings.IndexByte(body, '#'); idx >= 0 {
			name, _ = url.QueryUnescape(body[idx+1:])
			body = body[:idx]
		}
		decoded, ok := decodeBase64Flexible(body)
		if !ok {
			return nil, errors.New("SS 链接解码失败")
		}
		u, err = url.Parse("ss://" + decoded)
		if err != nil {
			return nil, err
		}
	}
	method := u.User.Username()
	password, hasPass := u.User.Password()
	if !hasPass && method != "" {
		if decoded, ok := decodeBase64Flexible(method); ok {
			parts := strings.SplitN(decoded, ":", 2)
			if len(parts) == 2 {
				method, password = parts[0], parts[1]
			}
		}
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || u.Hostname() == "" || method == "" {
		return nil, errors.New("SS 链接参数不完整")
	}
	if name == "" {
		name = fmt.Sprintf("SS-%s:%d", u.Hostname(), port)
	}
	return ProxyNode{
		"name":     name,
		"type":     "ss",
		"server":   u.Hostname(),
		"port":     port,
		"cipher":   method,
		"password": password,
		"udp":      true,
	}, nil
}

func parseVMessURI(raw string) (ProxyNode, error) {
	payload := strings.TrimPrefix(raw, "vmess://")
	decoded, ok := decodeBase64Flexible(payload)
	if !ok {
		return nil, errors.New("VMess 链接解码失败")
	}
	var m map[string]any
	if err := json.Unmarshal([]byte(decoded), &m); err != nil {
		return nil, errors.New("VMess JSON 无效")
	}
	server, _ := m["add"].(string)
	uuid, _ := m["id"].(string)
	port, okPort := toInt(m["port"])
	if server == "" || uuid == "" || !okPort || port < 1 {
		return nil, errors.New("VMess 缺少必填字段")
	}
	name, _ := m["ps"].(string)
	if name == "" {
		name = fmt.Sprintf("VMess-%s:%d", server, port)
	}
	aid, _ := toInt(m["aid"])
	node := ProxyNode{
		"name":               name,
		"type":               "vmess",
		"server":             server,
		"port":               port,
		"uuid":               uuid,
		"alterId":            aid,
		"cipher":             "auto",
		"udp":                true,
		"client-fingerprint": "chrome",
	}
	if tlsStr, _ := m["tls"].(string); strings.EqualFold(tlsStr, "tls") {
		node["tls"] = true
		if sni, _ := m["sni"].(string); sni != "" {
			node["servername"] = sni
		}
	}
	if netType, _ := m["net"].(string); netType == "ws" {
		node["network"] = "ws"
		wsOpts := map[string]any{}
		if p, _ := m["path"].(string); p != "" {
			wsOpts["path"] = p
		}
		if h, _ := m["host"].(string); h != "" {
			wsOpts["headers"] = map[string]any{"Host": h}
		}
		node["ws-opts"] = wsOpts
	}
	return node, nil
}

func parseVLESSURI(raw string) (ProxyNode, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(u.Port())
	uuid := u.User.Username()
	if err != nil || u.Hostname() == "" || uuid == "" {
		return nil, errors.New("VLESS 链接参数不完整")
	}
	q := u.Query()
	name, _ := url.QueryUnescape(u.Fragment)
	if name == "" {
		name = fmt.Sprintf("VLESS-%s:%d", u.Hostname(), port)
	}
	node := ProxyNode{
		"name":               name,
		"type":               "vless",
		"server":             u.Hostname(),
		"port":               port,
		"uuid":               uuid,
		"udp":                true,
		"client-fingerprint": defaultString(q.Get("fp"), "chrome"),
	}
	if flow := q.Get("flow"); flow != "" {
		node["flow"] = flow
	}
	sec := strings.ToLower(q.Get("security"))
	if sec == "tls" || sec == "reality" {
		node["tls"] = true
		if sni := q.Get("sni"); sni != "" {
			node["servername"] = sni
		}
		if sec == "reality" {
			node["reality-opts"] = map[string]any{
				"public-key": q.Get("pbk"),
				"short-id":   q.Get("sid"),
			}
		}
	}
	if netType := q.Get("type"); netType == "ws" {
		node["network"] = "ws"
		wsOpts := map[string]any{}
		if p := q.Get("path"); p != "" {
			wsOpts["path"] = p
		}
		if h := q.Get("host"); h != "" {
			wsOpts["headers"] = map[string]any{"Host": h}
		}
		node["ws-opts"] = wsOpts
	} else if netType == "grpc" {
		node["network"] = "grpc"
		node["grpc-opts"] = map[string]any{"grpc-service-name": q.Get("serviceName")}
	}
	return node, nil
}

func parseTrojanURI(raw string) (ProxyNode, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(u.Port())
	password := u.User.Username()
	if err != nil || u.Hostname() == "" || password == "" {
		return nil, errors.New("Trojan 链接参数不完整")
	}
	q := u.Query()
	name, _ := url.QueryUnescape(u.Fragment)
	if name == "" {
		name = fmt.Sprintf("Trojan-%s:%d", u.Hostname(), port)
	}
	node := ProxyNode{
		"name":               name,
		"type":               "trojan",
		"server":             u.Hostname(),
		"port":               port,
		"password":           password,
		"udp":                true,
		"client-fingerprint": defaultString(q.Get("fp"), "chrome"),
	}
	if sni := q.Get("sni"); sni != "" {
		node["sni"] = sni
	}
	return node, nil
}

func parseHysteria2URI(raw string) (ProxyNode, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(u.Port())
	password := u.User.Username()
	if err != nil || u.Hostname() == "" || password == "" {
		return nil, errors.New("Hysteria2 链接参数不完整")
	}
	q := u.Query()
	name, _ := url.QueryUnescape(u.Fragment)
	if name == "" {
		name = fmt.Sprintf("Hy2-%s:%d", u.Hostname(), port)
	}
	node := ProxyNode{
		"name":     name,
		"type":     "hysteria2",
		"server":   u.Hostname(),
		"port":     port,
		"password": password,
	}
	if sni := q.Get("sni"); sni != "" {
		node["sni"] = sni
	}
	return node, nil
}

func parseBasicProxyURI(raw, ptype string) (ProxyNode, error) {
	u, err := url.Parse(raw)
	if err != nil {
		return nil, err
	}
	port, err := strconv.Atoi(u.Port())
	if err != nil || u.Hostname() == "" {
		return nil, errors.New("代理链接缺少主机或端口")
	}
	name, _ := url.QueryUnescape(u.Fragment)
	if name == "" {
		name = fmt.Sprintf("%s-%s:%d", strings.ToUpper(ptype), u.Hostname(), port)
	}
	node := ProxyNode{
		"name":   name,
		"type":   ptype,
		"server": u.Hostname(),
		"port":   port,
	}
	if u.User != nil {
		if user := u.User.Username(); user != "" {
			node["username"] = user
		}
		if pass, ok := u.User.Password(); ok {
			node["password"] = pass
		}
	}
	return node, nil
}

func defaultString(val, fallback string) string {
	if strings.TrimSpace(val) == "" {
		return fallback
	}
	return val
}
