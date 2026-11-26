package envguardcore

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"time"
)

func isAllowedLocalOrigin(origin string) bool {
	if origin == "" {
		return true
	}
	return origin == "tauri://localhost" ||
		origin == "http://tauri.localhost" ||
		origin == "https://tauri.localhost" ||
		strings.HasPrefix(origin, "http://127.0.0.1:") ||
		strings.HasPrefix(origin, "http://localhost:") ||
		origin == "http://127.0.0.1" ||
		origin == "http://localhost"
}

func writeCORS(w http.ResponseWriter, r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if !isAllowedLocalOrigin(origin) {
		http.Error(w, `{"error":"forbidden origin"}`, http.StatusForbidden)
		return false
	}
	if origin != "" {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Vary", "Origin")
	}
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-CheckCC-Client, X-CheckCC-Token")
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func (c *MobileCore) helperHandler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/session", func(w http.ResponseWriter, r *http.Request) {
		if !writeCORS(w, r) {
			return
		}
		if r.Header.Get("X-CheckCC-Client") != "repair-ui" {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "invalid client"})
			return
		}
		c.mu.RLock()
		token := c.helperToken
		platform := c.platform
		c.mu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{
			"token":      token,
			"timezone":   c.systemTimezone(),
			"canRestore": false,
			"platform":   platform,
			"capabilities": map[string]any{
				"timezoneRead":           true,
				"timezoneWrite":          false,
				"timezoneFormat":         "iana",
				"timezoneAuthorization":  false,
				"browserLaunch":          false,
				"desktopLaunch":          false,
				"desktopMode":            "standard",
				"desktopScripts":         false,
				"desktopReason":          "移动端受系统沙盒限制，无法控制外部应用；可使用内置保护浏览器与系统 VPN 接管。",
				"platform":               platform,
				"vpnTakeover":            true,
				"protectedWebView":       true,
				"timezoneSettingsAction": true,
				"perAppProxy":            platform == "android",
			},
		})
	})

	mux.HandleFunc("/protection", func(w http.ResponseWriter, r *http.Request) {
		if !writeCORS(w, r) {
			return
		}
		if r.Method == http.MethodGet {
			writeJSON(w, http.StatusOK, c.buildProtectionReport())
			return
		}
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
			return
		}
		if !c.validHelperToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "invalid token"})
			return
		}
		var body struct {
			Action     string `json:"action"`
			Enabled    *bool  `json:"enabled"`
			Monitoring *bool  `json:"monitoring"`
			IntervalMs *int   `json:"intervalMs"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch body.Action {
		case "start", "restart", "resume":
			if err := c.startProtection(r.Context()); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
				return
			}
		case "stop":
			if err := c.stopProtection(); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
				return
			}
		case "startup":
			if body.Enabled != nil && *body.Enabled {
				_ = c.startProtection(r.Context())
			}
		case "monitor":
			c.mu.Lock()
			if body.Monitoring != nil {
				c.monitoring = *body.Monitoring
			}
			if body.IntervalMs != nil && *body.IntervalMs >= 10000 {
				c.intervalMs = *body.IntervalMs
			}
			c.mu.Unlock()
		}
		writeJSON(w, http.StatusOK, c.buildProtectionReport())
	})

	mux.HandleFunc("/environment", func(w http.ResponseWriter, r *http.Request) {
		if !writeCORS(w, r) {
			return
		}
		if !c.validHelperToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "invalid token"})
			return
		}
		var body struct {
			Policy map[string]any `json:"policy"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		writeJSON(w, http.StatusOK, map[string]any{
			"policy":    body.Policy,
			"appliedAt": time.Now().UTC().Format(time.RFC3339),
			"results": []map[string]any{{
				"target": "mobile-webview",
				"state":  "verified",
				"detail": "策略已下发至移动端内置保护浏览器。",
				"pages":  1,
			}},
		})
	})

	mux.HandleFunc("/browser-cloak", func(w http.ResponseWriter, r *http.Request) {
		if !writeCORS(w, r) {
			return
		}
		if !c.validHelperToken(r) {
			writeJSON(w, http.StatusForbidden, map[string]any{"error": "invalid token"})
			return
		}
		c.mu.RLock()
		target := c.target
		enabled := c.cloakEnabled && c.protectionEnabled
		updatedAt := c.cloakUpdatedAt
		c.mu.RUnlock()
		policy := map[string]any{}
		if target != nil {
			policy["languages"] = []string{target.Language}
			policy["locale"] = target.Locale
			if target.Timezone != nil {
				policy["timezone"] = *target.Timezone
			}
			policy["webrtcRelayOnly"] = true
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"enabled":          enabled,
			"policy":           policy,
			"appliedAt":        time.Now().UTC().Format(time.RFC3339),
			"gatewayUpdatedAt": updatedAt,
			"requestProbe":     nil,
			"results": []map[string]any{{
				"target": "web",
				"state":  "verified",
				"detail": "移动端已准备内置保护浏览器策略。",
				"pages":  1,
			}},
		})
	})

	mux.HandleFunc("/browsers", func(w http.ResponseWriter, r *http.Request) {
		if !writeCORS(w, r) {
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"browsers":  []any{},
			"excluded":  []string{},
			"preferred": nil,
			"active":    map[string]any{"id": "mobile-webview", "name": "内置保护浏览器", "path": "webview://protected-claude"},
		})
	})

	return mux
}

func (c *MobileCore) gatewayHandler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("/__checkcc/diagnostics", func(w http.ResponseWriter, r *http.Request) {
		if !writeCORS(w, r) {
			return
		}
		writeJSON(w, http.StatusOK, c.buildDiagnosticsReport(r.Context()))
	})

	mux.HandleFunc("/__checkcc/cloak", func(w http.ResponseWriter, r *http.Request) {
		if !writeCORS(w, r) {
			return
		}
		if r.Method == http.MethodPost {
			var body struct {
				Enabled bool `json:"enabled"`
			}
			_ = json.NewDecoder(r.Body).Decode(&body)
			c.mu.Lock()
			c.cloakEnabled = body.Enabled
			c.cloakUpdatedAt = time.Now().UTC().Format(time.RFC3339)
			c.mu.Unlock()
		}
		writeJSON(w, http.StatusOK, map[string]any{"cloak": c.buildCloakState()})
	})

	mux.HandleFunc("/__checkcc/net-core", func(w http.ResponseWriter, r *http.Request) {
		if !writeCORS(w, r) {
			return
		}
		if r.Method == http.MethodGet {
			writeJSON(w, http.StatusOK, map[string]any{
				"netCore":     c.buildNetCoreReport(),
				"exitHistory": c.buildExitHistory(),
			})
			return
		}
		var body struct {
			Action  string `json:"action"`
			Node    string `json:"node"`
			Enabled *bool  `json:"enabled"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		ok, reason := c.handleNetCoreAction(body.Action, body.Node, body.Enabled)
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      ok,
			"reason":  reason,
			"netCore": c.buildNetCoreReport(),
		})
	})

	mux.HandleFunc("/__checkcc/net-core/import", func(w http.ResponseWriter, r *http.Request) {
		if !writeCORS(w, r) {
			return
		}
		var body struct {
			Mode     string      `json:"mode"`
			URL      string      `json:"url"`
			Content  string      `json:"content"`
			Proxies  []ProxyNode `json:"proxies"`
			Selected string      `json:"selected"`
			Name     string      `json:"name"`
			SourceID string      `json:"sourceId"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "reason": "无效 JSON 参数"})
			return
		}
		res, err := c.importNodes(body.Mode, body.URL, body.Content, body.Proxies, body.Selected, body.Name, body.SourceID)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "reason": err.Error(), "netCore": c.buildNetCoreReport()})
			return
		}
		writeJSON(w, http.StatusOK, res)
	})

	mux.HandleFunc("/__checkcc/net-core/sources", func(w http.ResponseWriter, r *http.Request) {
		if !writeCORS(w, r) {
			return
		}
		var body struct {
			Action string `json:"action"`
			ID     string `json:"id"`
			Name   string `json:"name"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		ok, reason := c.handleSourceAction(body.Action, body.ID, body.Name)
		c.mu.RLock()
		activeID := c.sources.ActiveID
		sources := c.sources.Public()
		c.mu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":       ok,
			"reason":   reason,
			"activeId": activeID,
			"sources":  sources,
			"netCore":  c.buildNetCoreReport(),
		})
	})

	mux.HandleFunc("/__checkcc/net-core/mode", func(w http.ResponseWriter, r *http.Request) {
		if !writeCORS(w, r) {
			return
		}
		var body struct {
			Mode string `json:"mode"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Mode != "rule" && body.Mode != "global" && body.Mode != "direct" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "reason": "不支持的代理模式"})
			return
		}
		c.mu.Lock()
		c.egressMode = body.Mode
		c.mu.Unlock()
		if err := c.applyKernelLocked(); err != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "reason": err.Error(), "netCore": c.buildNetCoreReport()})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "mode": body.Mode, "netCore": c.buildNetCoreReport()})
	})

	mux.HandleFunc("/__checkcc/net-core/network-failure", func(w http.ResponseWriter, r *http.Request) {
		if !writeCORS(w, r) {
			return
		}
		var body struct {
			Policy string `json:"policy"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body.Policy != "claude" && body.Policy != "all" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "reason": "无效断流策略"})
			return
		}
		c.mu.Lock()
		c.failureMode = body.Policy
		c.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "networkFailure": body.Policy, "netCore": c.buildNetCoreReport()})
	})

	mux.HandleFunc("/__checkcc/net-core/network", func(w http.ResponseWriter, r *http.Request) {
		if !writeCORS(w, r) {
			return
		}
		if r.Method == http.MethodPost {
			var body struct {
				Config  LocalNetworkConfig `json:"config"`
				Restart bool               `json:"restart"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "reason": "无效网络配置"})
				return
			}
			for _, addr := range body.Config.RouteExcludeAddresses {
				if _, err := normalizeIPv4CIDR(addr); err != nil {
					writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "reason": err.Error()})
					return
				}
			}
			if err := c.saveNetworkConfig(body.Config); err != nil {
				writeJSON(w, http.StatusInternalServerError, map[string]any{"ok": false, "reason": err.Error()})
				return
			}
			c.mu.Lock()
			c.networkCfg = body.Config
			c.mu.Unlock()
			if body.Restart {
				_ = c.applyKernelLocked()
			}
		}
		c.mu.RLock()
		cfg := c.networkCfg
		path := filepath.Join(c.stateDir, "net-core-network.json")
		c.mu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":             true,
			"path":           path,
			"config":         cfg,
			"effective":      nil,
			"problem":        nil,
			"interfaces":     []any{},
			"pendingRestart": false,
			"canRestart":     true,
			"netCore":        c.buildNetCoreReport(),
		})
	})

	mux.HandleFunc("/__checkcc/net-core/connections", func(w http.ResponseWriter, r *http.Request) {
		if !writeCORS(w, r) {
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":             true,
			"available":      c.kernel.IsRunning(),
			"storageError":   false,
			"retentionHours": 24,
			"stats":          map[string]int{"active": 0, "ended": 0, "total": 0},
			"total":          0,
			"offset":         0,
			"limit":          50,
			"items":          []any{},
			"recent":         []any{},
			"scope":          "all",
		})
	})

	mux.HandleFunc("/__checkcc/net-core/delay", func(w http.ResponseWriter, r *http.Request) {
		if !writeCORS(w, r) {
			return
		}
		c.mu.RLock()
		delays := c.delays
		c.mu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"delays":  delays,
			"netCore": c.buildNetCoreReport(),
		})
	})

	mux.HandleFunc("/__checkcc/net-core/exits", func(w http.ResponseWriter, r *http.Request) {
		if !writeCORS(w, r) {
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"exits":   map[string]any{},
			"netCore": c.buildNetCoreReport(),
		})
	})

	mux.HandleFunc("/__checkcc/updates", func(w http.ResponseWriter, r *http.Request) {
		if !writeCORS(w, r) {
			return
		}
		c.mu.RLock()
		ver, plat, arch := c.appVersion, c.platform, c.arch
		c.mu.RUnlock()
		writeJSON(w, http.StatusOK, map[string]any{
			"currentVersion": ver,
			"platform":       plat,
			"arch":           arch,
			"checkedAt":      time.Now().UTC().Format(time.RFC3339),
			"status":         "current",
			"releasesUrl":    "https://github.com/AACS111/EnvGuardCC/releases",
		})
	})

	return mux
}

func (c *MobileCore) validHelperToken(r *http.Request) bool {
	c.mu.RLock()
	token := c.helperToken
	c.mu.RUnlock()
	return r.Header.Get("X-CheckCC-Client") == "repair-ui" && r.Header.Get("X-CheckCC-Token") == token
}

func (c *MobileCore) startProtection(ctx context.Context) error {
	c.mu.Lock()
	active := c.sources.Active()
	if active == nil || len(active.Proxies) == 0 {
		c.mu.Unlock()
		return fmt.Errorf("请先导入至少一个代理节点再启动环境防护。")
	}
	c.desiredEnabled = true
	c.protectionPhase = "starting"
	delegate := c.vpnDelegate
	mixedPort := c.mixedPort
	c.mu.Unlock()

	if delegate != nil {
		if err := delegate.RequestStartVPN(); err != nil {
			c.mu.Lock()
			c.protectionPhase = "idle"
			c.mu.Unlock()
			return fmt.Errorf("系统 VPN 授权或启动失败：%w", err)
		}
	}

	// Probe exit via local proxy if kernel is running; verify Claude supported region.
	proxyAddr := ""
	if c.kernel.IsRunning() {
		proxyAddr = fmt.Sprintf("http://127.0.0.1:%d", mixedPort)
	}
	client := proxyHTTPClient(proxyAddr, 8*time.Second)
	sources := probeGeoSources(ctx, client)

	c.mu.Lock()
	if len(sources) > 0 {
		primary := sources[0]
		if !isClaudeSupportedCountry(primary.CountryCode) {
			c.regionLocked = true
			c.regionLockReason = fmt.Sprintf("当前出口地区 %s 不在 Claude 支持列表内，已拒绝放行 Claude 域名。", primary.CountryCode)
			c.regionLockCountry = primary.CountryCode
			c.regionLockIP = primary.IP
			c.protectionEnabled = false
			c.protectionPhase = "idle"
			c.appendHistory(c.regionLockReason)
			c.mu.Unlock()
			_ = c.applyKernelLocked()
			return fmt.Errorf("%s", c.regionLockReason)
		}
		lang, loc := targetForCountry(primary.CountryCode)
		c.target = &ProtectionTarget{
			IP:          primary.IP,
			CountryCode: primary.CountryCode,
			CountryName: primary.CountryCode,
			City:        primary.City,
			Timezone:    primary.Timezone,
			Language:    lang,
			Locale:      loc,
		}
		cc := primary.CountryCode
		c.exitHistory = append([]ExitHistoryEntry{{
			IP:          primary.IP,
			At:          time.Now().UTC().Format(time.RFC3339),
			CountryCode: &cc,
		}}, c.exitHistory...)
		if len(c.exitHistory) > 50 {
			c.exitHistory = c.exitHistory[:50]
		}
	}
	c.regionLocked = false
	c.protectionEnabled = true
	c.protectionPhase = "active"
	c.appendHistory("移动端环境防护与 VPN 接管已开启。")
	c.mu.Unlock()

	return c.applyKernelLocked()
}

func (c *MobileCore) stopProtection() error {
	c.mu.Lock()
	c.desiredEnabled = false
	c.protectionEnabled = false
	c.protectionPhase = "idle"
	c.appendHistory("已关闭环境防护；VPN 运行期间将保持阻断 Claude 直连。")
	c.mu.Unlock()
	return c.applyKernelLocked()
}

func (c *MobileCore) handleNetCoreAction(action, node string, enabled *bool) (bool, *string) {
	errStr := func(err error) (bool, *string) {
		if err == nil {
			return true, nil
		}
		s := err.Error()
		return false, &s
	}
	switch action {
	case "start", "restart":
		return errStr(c.applyKernelLocked())
	case "stop":
		return errStr(c.kernel.Stop())
	case "select":
		c.mu.Lock()
		if active := c.sources.Active(); active != nil {
			active.Selected = node
			_ = saveSourceStore(c.stateDir, c.sources)
		}
		c.mu.Unlock()
		return errStr(c.applyKernelLocked())
	case "tunnel":
		want := enabled == nil || *enabled
		c.mu.RLock()
		delegate := c.vpnDelegate
		c.mu.RUnlock()
		if want {
			if delegate != nil {
				if err := delegate.RequestStartVPN(); err != nil {
					return errStr(err)
				}
			}
			c.mu.Lock()
			c.tunEnabled = true
			c.mu.Unlock()
			return errStr(c.applyKernelLocked())
		}
		if delegate != nil {
			_ = delegate.RequestStopVPN()
		}
		return errStr(c.DetachTunnel())
	case "unlock-region":
		c.mu.Lock()
		c.regionLocked = false
		c.regionLockReason = ""
		c.mu.Unlock()
		return errStr(c.applyKernelLocked())
	default:
		msg := fmt.Sprintf("不支持的动作：%s", action)
		return false, &msg
	}
}

func (c *MobileCore) importNodes(mode, rawURL, content string, manual []ProxyNode, selected, name, sourceID string) (map[string]any, error) {
	var nodes []ProxyNode
	var skipped []map[string]any
	var err error
	switch mode {
	case "url":
		text, fetchErr := fetchSubscriptionURL(rawURL, nil)
		if fetchErr != nil {
			return nil, fetchErr
		}
		nodes, skipped, err = ParseSubscription(text)
	case "content":
		nodes, skipped, err = ParseSubscription(content)
	case "manual":
		rawAny := make([]any, 0, len(manual))
		for _, m := range manual {
			rawAny = append(rawAny, map[string]any(m))
		}
		nodes, skipped = normalizeProxySlice(rawAny)
		if len(nodes) == 0 {
			err = fmt.Errorf("未提供有效节点")
		}
	default:
		return nil, fmt.Errorf("移动端不支持导入模式：%s", mode)
	}
	if err != nil {
		return nil, err
	}
	if selected == "" && len(nodes) > 0 {
		selected = proxyName(nodes[0])
	}
	if strings.TrimSpace(name) == "" {
		name = fmt.Sprintf("配置 %d", len(c.sources.Sources)+1)
	}
	c.mu.Lock()
	if sourceID == "" {
		sourceID = "src-" + randomHex(6)
	}
	record := SourceRecord{
		ID:            sourceID,
		Name:          name,
		Mode:          mode,
		URL:           rawURL,
		Proxies:       nodes,
		Selected:      selected,
		UpdatedAt:     time.Now().UTC().Format(time.RFC3339),
		IntervalHours: 12,
	}
	replaced := false
	for i := range c.sources.Sources {
		if c.sources.Sources[i].ID == sourceID {
			c.sources.Sources[i] = record
			replaced = true
			break
		}
	}
	if !replaced {
		c.sources.Sources = append(c.sources.Sources, record)
	}
	c.sources.ActiveID = sourceID
	saveErr := saveSourceStore(c.stateDir, c.sources)
	c.mu.Unlock()
	if saveErr != nil {
		return nil, saveErr
	}
	_ = c.applyKernelLocked()
	return map[string]any{
		"ok":       true,
		"imported": len(nodes),
		"skipped":  skipped,
		"selected": selected,
		"netCore":  c.buildNetCoreReport(),
	}, nil
}

func (c *MobileCore) handleSourceAction(action, id, name string) (bool, *string) {
	c.mu.Lock()
	defer func() { _ = saveSourceStore(c.stateDir, c.sources) }()
	switch action {
	case "activate":
		c.sources.ActiveID = id
		c.mu.Unlock()
		_ = c.applyKernelLocked()
		c.mu.Lock()
		c.mu.Unlock()
		return true, nil
	case "rename":
		for i := range c.sources.Sources {
			if c.sources.Sources[i].ID == id && strings.TrimSpace(name) != "" {
				c.sources.Sources[i].Name = strings.TrimSpace(name)
			}
		}
		c.mu.Unlock()
		return true, nil
	case "delete":
		next := make([]SourceRecord, 0, len(c.sources.Sources))
		for _, s := range c.sources.Sources {
			if s.ID != id {
				next = append(next, s)
			}
		}
		c.sources.Sources = next
		if c.sources.ActiveID == id {
			c.sources.ActiveID = ""
			if len(next) > 0 {
				c.sources.ActiveID = next[0].ID
			}
		}
		c.mu.Unlock()
		_ = c.applyKernelLocked()
		return true, nil
	default:
		c.mu.Unlock()
		msg := "不支持的来源操作"
		return false, &msg
	}
}

func (c *MobileCore) buildProtectionReport() map[string]any {
	c.mu.RLock()
	defer c.mu.RUnlock()
	issues := []string{}
	sysTZ := c.systemTimezone()
	if c.protectionEnabled && c.target != nil && c.target.Timezone != nil && *c.target.Timezone != "" && sysTZ != *c.target.Timezone {
		issues = append(issues, fmt.Sprintf("系统时区（%s）与出口目标时区（%s）不一致：移动端受系统限制无法自动修改，请在系统设置手动调整或使用内置保护浏览器。", sysTZ, *c.target.Timezone))
	}
	return map[string]any{
		"phase":          c.protectionPhase,
		"enabled":        c.protectionEnabled,
		"desiredEnabled": c.desiredEnabled,
		"target":         c.target,
		"issues":         issues,
		"systemTimezone": sysTZ,
		"unprotectedBlock": map[string]any{
			"active": c.tunEnabled && !c.protectionEnabled,
			"error":  nil,
		},
		"connection": map[string]any{
			"state":            map[bool]string{true: "verified", false: "idle"}[c.tunEnabled],
			"checkedAt":        time.Now().UTC().Format(time.RFC3339),
			"tunCaptured":      c.tunEnabled,
			"reason":           nil,
			"systemKillSwitch": false,
			"strictTravel":     false,
		},
		"history":    c.history,
		"lastTestAt": nil,
		"nextTestAt": nil,
		"runId":      "mobile-core",
		"score":      nil,
		"alarm":      false,
		"monitoring": c.monitoring,
		"intervalMs": c.intervalMs,
	}
}

func (c *MobileCore) buildCloakState() map[string]any {
	c.mu.RLock()
	defer c.mu.RUnlock()
	var target any
	if c.target != nil {
		target = map[string]any{
			"language":    c.target.Language,
			"locale":      c.target.Locale,
			"timezone":    c.target.Timezone,
			"countryName": c.target.CountryName,
			"updatedAt":   c.cloakUpdatedAt,
		}
	}
	return map[string]any{
		"enabled":   c.cloakEnabled,
		"updatedAt": c.cloakUpdatedAt,
		"target":    target,
	}
}

func (c *MobileCore) buildNetCoreReport() map[string]any {
	c.mu.RLock()
	defer c.mu.RUnlock()
	active := c.sources.Active()
	nodes := []string{}
	var selected any
	if active != nil {
		for _, p := range active.Proxies {
			nodes = append(nodes, proxyName(p))
		}
		if active.Selected != "" {
			selected = active.Selected
		}
	}
	state := "idle"
	if len(nodes) == 0 {
		state = "disabled"
	} else if c.kernel.IsRunning() {
		state = "running"
	}
	claudeBlocked := !c.protectionEnabled || c.regionLocked
	guardState := "open"
	if claudeBlocked {
		guardState = "blocked"
	}
	var regionLock any
	if c.regionLocked {
		regionLock = map[string]any{
			"locked":      true,
			"type":        "region",
			"reason":      c.regionLockReason,
			"countryCode": c.regionLockCountry,
			"ip":          c.regionLockIP,
		}
	}
	return map[string]any{
		"enabled":              len(nodes) > 0,
		"state":                state,
		"tunEnabled":           c.tunEnabled,
		"tunCaptured":          c.tunEnabled,
		"hostMode":             true,
		"nodes":                nodes,
		"selected":             selected,
		"sources":              c.sources.Public(),
		"activeId":             c.sources.ActiveID,
		"version":              "mihomo-v1.19.33-mobile",
		"restarts":             c.restarts,
		"localProxy":           fmt.Sprintf("http://127.0.0.1:%d", c.mixedPort),
		"mode":                 c.egressMode,
		"networkFailurePolicy": c.failureMode,
		"claudeBlocked":        claudeBlocked,
		"claudeGuard":          guardState,
		"regionLock":           regionLock,
		"delays":               c.delays,
		"capabilities": map[string]any{
			"independentProxy": true,
			"systemKillSwitch": false,
			"strictTravel":     false,
		},
	}
}

func (c *MobileCore) buildExitHistory() map[string]any {
	c.mu.RLock()
	defer c.mu.RUnlock()
	var current any
	ips := []string{}
	seen := map[string]bool{}
	for _, e := range c.exitHistory {
		if current == nil {
			current = e.IP
		}
		if !seen[e.IP] {
			seen[e.IP] = true
			ips = append(ips, e.IP)
		}
	}
	return map[string]any{
		"windowHours": 24,
		"samples":     len(c.exitHistory),
		"changes":     max(0, len(ips)-1),
		"stable":      len(ips) <= 1,
		"current":     current,
		"ips":         ips,
		"entries":     c.exitHistory,
	}
}

func (c *MobileCore) buildDiagnosticsReport(ctx context.Context) map[string]any {
	c.mu.RLock()
	platform := c.platform
	mixedPort := c.mixedPort
	running := c.kernel.IsRunning()
	c.mu.RUnlock()

	proxyAddr := ""
	proxyMode := "direct"
	if running {
		proxyAddr = fmt.Sprintf("http://127.0.0.1:%d", mixedPort)
		proxyMode = "http-connect"
	}
	client := proxyHTTPClient(proxyAddr, 8*time.Second)
	sources := probeGeoSources(ctx, client)
	var primary *GeoSource
	var ipv4 *string
	if len(sources) > 0 {
		primary = &sources[0]
		ip := primary.IP
		ipv4 = &ip
	}
	var consistent *bool
	if len(sources) >= 2 {
		same := sources[0].CountryCode == sources[1].CountryCode
		consistent = &same
	}
	claudeProbe := probeHTTP(ctx, client, "https://claude.ai/")
	anthropicProbe := probeHTTP(ctx, client, "https://www.anthropic.com/")
	apiProbe := probeHTTP(ctx, client, "https://api.anthropic.com/v1/messages")
	edge := probeCloudflareTrace(ctx, client)

	return map[string]any{
		"version":                  1,
		"upstream":                 "https://api.anthropic.com",
		"platform":                 platform,
		"profileError":             nil,
		"profile":                  c.buildCloakState()["target"],
		"proxy":                    map[string]any{"mode": proxyMode, "source": "mobile-core", "address": proxyAddr},
		"transport":                "go-mobile-core",
		"proxyEnvironmentDetected": running,
		"rewrites":                 0,
		"previewHeaders":           map[string]string{},
		"lastRequest":              nil,
		"lastFailure":              nil,
		"checkedAt":                time.Now().UTC().Format(time.RFC3339),
		"probes": map[string]any{
			"claude":    claudeProbe,
			"anthropic": anthropicProbe,
			"api":       apiProbe,
		},
		"exit": map[string]any{
			"sources":           sources,
			"primary":           primary,
			"ipv4":              ipv4,
			"ipv6":              nil,
			"consistentCountry": consistent,
		},
		"edge":    edge,
		"cloak":   c.buildCloakState(),
		"netCore": c.buildNetCoreReport(),
	}
}
