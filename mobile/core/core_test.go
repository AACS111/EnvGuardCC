package envguardcore

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"testing"
)

func TestParseSubscriptionYAMLAndURI(t *testing.T) {
	yamlSub := `
proxies:
  - name: "US Residential"
    type: socks5
    server: 198.51.100.10
    port: 1080
`
	nodes, skipped, err := ParseSubscription(yamlSub)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if len(nodes) != 1 || len(skipped) != 0 {
		t.Fatalf("expected 1 node, got %d (skipped %d)", len(nodes), len(skipped))
	}
	if proxyName(nodes[0]) != "US Residential" {
		t.Fatalf("unexpected node name: %s", proxyName(nodes[0]))
	}

	rawURIs := "trojan://secretpass@example.com:443?sni=example.com#JP-Node\n" +
		"vless://11111111-1111-1111-1111-111111111111@example.org:443?security=tls&sni=example.org#SG-Node"
	encoded := base64.StdEncoding.EncodeToString([]byte(rawURIs))
	uriNodes, _, err := ParseSubscription(encoded)
	if err != nil {
		t.Fatalf("base64 URI parse failed: %v", err)
	}
	if len(uriNodes) != 2 {
		t.Fatalf("expected 2 URI nodes, got %d", len(uriNodes))
	}
}

func TestBuildMihomoConfigInvariants(t *testing.T) {
	nodes := []ProxyNode{
		{"name": "US-1", "type": "socks5", "server": "198.51.100.10", "port": 1080},
		{"name": "JP-1", "type": "socks5", "server": "198.51.100.11", "port": 1080},
	}
	cfg, err := BuildMihomoConfig(KernelConfigOptions{
		Proxies:        nodes,
		Selected:       "JP-1",
		EgressMode:     "rule",
		MixedPort:      39180,
		ControllerPort: 39090,
		Secret:         "test-secret",
		TunEnabled:     true,
		TunFD:          42,
		Platform:       "ios",
		ClaudeBlocked:  true,
	})
	if err != nil {
		t.Fatalf("BuildMihomoConfig failed: %v", err)
	}
	for _, want := range []string{
		"CLAUDE-GUARD",
		"CLAUDE-PIN",
		"AUTO-PROXY",
		"DOMAIN-SUFFIX,claude.ai,CLAUDE-GUARD",
		"DST-PORT,3478,REJECT",
		"stack: gvisor",
		"file-descriptor: 42",
	} {
		if !strings.Contains(cfg, want) {
			t.Fatalf("expected config to contain %q\n%s", want, cfg)
		}
	}
}

func TestMobileCoreHTTPAPIContract(t *testing.T) {
	dir := t.TempDir()
	core, err := NewMobileCore(dir, "0.2.6", "android", "arm64", 64)
	if err != nil {
		t.Fatalf("NewMobileCore failed: %v", err)
	}
	if err := core.StartServers(0, 0); err != nil {
		t.Fatalf("StartServers failed: %v", err)
	}
	defer func() { _ = core.Close() }()

	helperURL := fmt.Sprintf("http://127.0.0.1:%d", core.HelperPort())
	gatewayURL := fmt.Sprintf("http://127.0.0.1:%d", core.GatewayPort())

	req, _ := http.NewRequest(http.MethodGet, helperURL+"/session", nil)
	req.Header.Set("Origin", "http://tauri.localhost")
	req.Header.Set("X-CheckCC-Client", "repair-ui")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("GET /session failed: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200, got %d", resp.StatusCode)
	}
	var session map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&session); err != nil {
		t.Fatalf("decode session failed: %v", err)
	}
	if session["platform"] != "android" {
		t.Fatalf("unexpected platform: %v", session["platform"])
	}

	// Import a node via Gateway API.
	payload := `{"mode":"content","name":"Test","content":"socks5://198.51.100.10:1080#US-Home"}`
	impReq, _ := http.NewRequest(http.MethodPost, gatewayURL+"/__checkcc/net-core/import", bytes.NewBufferString(payload))
	impReq.Header.Set("Origin", "http://tauri.localhost")
	impReq.Header.Set("X-CheckCC-Client", "gateway-ui")
	impReq.Header.Set("Content-Type", "application/json")
	impResp, err := http.DefaultClient.Do(impReq)
	if err != nil {
		t.Fatalf("import failed: %v", err)
	}
	defer impResp.Body.Close()
	if impResp.StatusCode != http.StatusOK {
		t.Fatalf("expected 200 on import, got %d", impResp.StatusCode)
	}
	var impBody map[string]any
	_ = json.NewDecoder(impResp.Body).Decode(&impBody)
	if impBody["ok"] != true {
		t.Fatalf("expected ok=true, got %v", impBody)
	}
}
