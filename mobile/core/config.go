package envguardcore

import (
	"errors"
	"fmt"
	"net"
	"strings"

	"gopkg.in/yaml.v3"
)

const (
	GroupClaudePin      = "CLAUDE-PIN"
	GroupClaudeGuard    = "CLAUDE-GUARD"
	GroupAutoProxy      = "AUTO-PROXY"
	DelayTestURL        = "https://www.gstatic.com/generate_204"
	DefaultFakeIPRange  = "198.18.0.1/16"
)

var ClaudeDomains = []string{
	"anthropic.com",
	"claude.ai",
	"claude.com",
	"claudeusercontent.com",
	"challenges.cloudflare.com",
}

var STUNPorts = []int{3478, 5349, 19302, 19303}

var CNDirectDomains = []string{
	"cn", "gov.cn", "edu.cn", "baidu.com", "qq.com", "tencent.com",
	"weixin.qq.com", "wechat.com", "aliyun.com", "alipay.com", "taobao.com",
	"tmall.com", "alibaba.com", "jd.com", "pinduoduo.com", "meituan.com",
	"12306.cn", "bilibili.com", "douyin.com", "weibo.com", "zhihu.com",
	"163.com", "xiaomi.com", "huawei.com", "bytedance.com", "gitee.com",
}

var DefaultRouteExclusions = []string{
	"127.0.0.0/8",
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"169.254.0.0/16",
}

// LocalNetworkConfig mirrors desktop net-core-network.json.
type LocalNetworkConfig struct {
	DirectDomains         []string `json:"directDomains,omitempty"`
	DNSServers            []string `json:"dnsServers,omitempty"`
	DirectInterface       string   `json:"directInterface,omitempty"`
	DNSInterface          string   `json:"dnsInterface,omitempty"`
	StrictRoute           *bool    `json:"strictRoute,omitempty"`
	RouteExcludeAddresses []string `json:"routeExcludeAddresses,omitempty"`
}

// KernelConfigOptions drives mobile mihomo config generation with desktop parity.
type KernelConfigOptions struct {
	Proxies        []ProxyNode
	Selected       string
	EgressMode     string // rule | global | direct
	MixedPort      int
	ControllerPort int
	Secret         string
	TunEnabled     bool
	TunFD          int
	TunMTU         int
	Platform       string // android | ios
	ClaudeBlocked  bool
	LocalNetwork   LocalNetworkConfig
}

// BuildMihomoConfig produces a YAML configuration enforcing EnvGuardCC's desktop invariants:
//   1. Claude domains stay pinned at top of rules via CLAUDE-GUARD -> CLAUDE-PIN / REJECT.
//   2. CLAUDE-PIN is strictly `select` (never auto-switched by latency).
//   3. Non-Claude traffic uses `AUTO-PROXY` fallback group.
//   4. STUN UDP ports are rejected to prevent WebRTC public IP leakage.
//   5. Fake-IP DNS with DoH prevents local DNS leakage, tuned for mobile memory limits.
func BuildMihomoConfig(opts KernelConfigOptions) (string, error) {
	if len(opts.Proxies) == 0 {
		return "", errors.New("至少需要一个有效节点。")
	}
	names := make([]string, 0, len(opts.Proxies))
	selectedFound := false
	for _, p := range opts.Proxies {
		n := proxyName(p)
		if n == "" {
			continue
		}
		names = append(names, n)
		if n == opts.Selected {
			selectedFound = true
		}
	}
	if len(names) == 0 {
		return "", errors.New("节点列表为空。")
	}
	selected := opts.Selected
	if !selectedFound {
		selected = names[0]
	}
	mode := opts.EgressMode
	if mode != "rule" && mode != "global" && mode != "direct" {
		mode = "rule"
	}

	// Put selected node first so select group starts pinned to the user's choice.
	orderedNames := make([]string, 0, len(names))
	orderedNames = append(orderedNames, selected)
	for _, n := range names {
		if n != selected {
			orderedNames = append(orderedNames, n)
		}
	}

	guardProxies := []string{GroupClaudePin, "REJECT"}
	if opts.ClaudeBlocked {
		guardProxies = []string{"REJECT", GroupClaudePin}
	}

	proxyGroups := []map[string]any{
		{
			"name":    GroupClaudeGuard,
			"type":    "select",
			"proxies": guardProxies,
		},
		{
			"name":    GroupClaudePin,
			"type":    "select",
			"proxies": orderedNames,
		},
		{
			"name":     GroupAutoProxy,
			"type":     "fallback",
			"proxies":  orderedNames,
			"url":      DelayTestURL,
			"interval": 300,
			"lazy":     false,
		},
	}

	rules := make([]string, 0, 128)
	// 1. Always keep Claude ecosystem domains pinned at the very top.
	for _, domain := range ClaudeDomains {
		rules = append(rules, fmt.Sprintf("DOMAIN-SUFFIX,%s,%s", domain, GroupClaudeGuard))
	}
	// 2. Reject STUN ports to prevent WebRTC IP leaks.
	for _, port := range STUNPorts {
		rules = append(rules, fmt.Sprintf("DST-PORT,%d,REJECT", port))
	}
	// 3. Private / LAN routes stay direct.
	for _, cidr := range DefaultRouteExclusions {
		rules = append(rules, fmt.Sprintf("IP-CIDR,%s,DIRECT,no-resolve", cidr))
	}
	rules = append(rules,
		"IP-CIDR6,::1/128,DIRECT,no-resolve",
		"IP-CIDR6,fc00::/7,DIRECT,no-resolve",
		"IP-CIDR6,fe80::/10,DIRECT,no-resolve",
	)
	// 4. User-configured intranet direct domains & IP exclusions.
	for _, d := range opts.LocalNetwork.DirectDomains {
		clean := strings.TrimSpace(strings.ToLower(d))
		if clean != "" {
			rules = append(rules, fmt.Sprintf("DOMAIN-SUFFIX,%s,DIRECT", clean))
		}
	}
	for _, raw := range opts.LocalNetwork.RouteExcludeAddresses {
		cidr, err := normalizeIPv4CIDR(raw)
		if err != nil {
			return "", err
		}
		rules = append(rules, fmt.Sprintf("IP-CIDR,%s,DIRECT,no-resolve", cidr))
	}

	// 5. Egress mode rules.
	switch mode {
	case "global":
		rules = append(rules, fmt.Sprintf("MATCH,%s", GroupAutoProxy))
	case "direct":
		rules = append(rules, "MATCH,DIRECT")
	default: // rule
		for _, domain := range CNDirectDomains {
			rules = append(rules, fmt.Sprintf("DOMAIN-SUFFIX,%s,DIRECT", domain))
		}
		rules = append(rules, fmt.Sprintf("MATCH,%s", GroupAutoProxy))
	}

	// DNS settings: DoH via proxy, Fake-IP, minimal memory footprint on iOS.
	dnsServers := []string{"https://1.1.1.1/dns-query", "https://8.8.8.8/dns-query"}
	if len(opts.LocalNetwork.DNSServers) > 0 {
		dnsServers = opts.LocalNetwork.DNSServers
	}
	dnsConfig := map[string]any{
		"enable":              true,
		"ipv6":                false,
		"enhanced-mode":       "fake-ip",
		"fake-ip-range":       DefaultFakeIPRange,
		"respect-rules":       true,
		"default-nameserver":  []string{"223.5.5.5", "1.1.1.1"},
		"nameserver":          dnsServers,
		"proxy-server-nameserver": []string{"223.5.5.5", "1.1.1.1"},
		"fake-ip-filter": []string{
			"*.lan", "*.local", "*.home.arpa", "localhost.ptlogin2.qq.com",
		},
	}

	strictRoute := true
	if opts.LocalNetwork.StrictRoute != nil {
		strictRoute = *opts.LocalNetwork.StrictRoute
	}
	tunStack := "system"
	if opts.Platform == "ios" {
		// gVisor userspace stack is required inside iOS NEPacketTunnelProvider sandbox.
		tunStack = "gvisor"
	}
	mtu := opts.TunMTU
	if mtu <= 0 {
		mtu = 9000
		if opts.Platform == "ios" {
			mtu = 1500
		}
	}
	tunConfig := map[string]any{
		"enable":              opts.TunEnabled,
		"stack":               tunStack,
		"mtu":                 mtu,
		"dns-hijack":          []string{"any:53"},
		"auto-route":          opts.TunFD <= 0,
		"auto-detect-interface": opts.TunFD <= 0,
		"strict-route":        strictRoute,
	}
	if opts.TunFD > 0 {
		tunConfig["file-descriptor"] = opts.TunFD
	}

	doc := map[string]any{
		"mixed-port":          opts.MixedPort,
		"allow-lan":           false,
		"bind-address":        "127.0.0.1",
		"mode":                "rule",
		"log-level":           "warning",
		"ipv6":                false,
		"external-controller": fmt.Sprintf("127.0.0.1:%d", opts.ControllerPort),
		"secret":              opts.Secret,
		"profile": map[string]any{
			"store-selected": false,
			"store-fake-ip":  false,
		},
		"dns":          dnsConfig,
		"tun":          tunConfig,
		"proxies":      opts.Proxies,
		"proxy-groups": proxyGroups,
		"rules":        rules,
	}

	out, err := yaml.Marshal(doc)
	if err != nil {
		return "", err
	}
	return string(out), nil
}

func normalizeIPv4CIDR(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", errors.New("空的豁免网段")
	}
	if !strings.Contains(trimmed, "/") {
		ip := net.ParseIP(trimmed)
		if ip == nil || ip.To4() == nil {
			return "", fmt.Errorf("无效 IPv4 地址：%s", raw)
		}
		return ip.To4().String() + "/32", nil
	}
	ip, ipNet, err := net.ParseCIDR(trimmed)
	if err != nil || ip.To4() == nil {
		return "", fmt.Errorf("无效 IPv4 CIDR：%s", raw)
	}
	return ipNet.String(), nil
}
