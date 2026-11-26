use serde_json::{json, Value};
use std::path::Path;

/// Origins accepted by the mobile Tauri WebView (Android `http(s)://tauri.localhost`
/// and iOS `tauri://localhost`, plus optional loopback dev server).
pub fn is_trusted_mobile_origin(label: &str, url: &tauri::Url) -> bool {
    if label != "main" {
        return false;
    }
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => matches!(
            url.host_str(),
            Some("tauri.localhost") | Some("127.0.0.1") | Some("localhost")
        ),
        _ => false,
    }
}

/// Validates target URLs allowed inside the in-app protected Claude WebView.
pub fn is_allowed_protected_browser_url(raw: &str) -> Result<tauri::Url, String> {
    let parsed = tauri::Url::parse(raw.trim()).map_err(|e| format!("无效的网址：{e}"))?;
    if parsed.scheme() != "https" {
        return Err("受保护浏览器仅允许访问 HTTPS 地址。".into());
    }
    let host = parsed
        .host_str()
        .map(|h| h.to_ascii_lowercase())
        .ok_or_else(|| "缺少目标域名。".to_string())?;
    let allowed = matches!(
        host.as_str(),
        "claude.ai" | "www.claude.ai" | "claude.com" | "www.claude.com" | "console.anthropic.com" | "anthropic.com"
    ) || host.ends_with(".claude.ai")
        || host.ends_with(".anthropic.com");
    if !allowed {
        return Err(format!("受保护浏览器仅支持 Claude / Anthropic 官方域名，拒绝访问：{host}"));
    }
    Ok(parsed)
}

#[derive(Debug, Clone)]
pub struct MobileSettings {
    pub auto_start_protection: bool,
    pub per_app_proxy: bool,
    pub allowed_apps: Vec<String>,
}

impl Default for MobileSettings {
    fn default() -> Self {
        Self {
            auto_start_protection: false,
            per_app_proxy: false,
            allowed_apps: vec![
                "com.anthropic.claude".to_string(),
                "com.android.chrome".to_string(),
            ],
        }
    }
}

impl MobileSettings {
    pub fn load(path: &Path) -> Self {
        let Ok(raw) = std::fs::read_to_string(path) else {
            return Self::default();
        };
        let Ok(val) = serde_json::from_str::<Value>(&raw) else {
            return Self::default();
        };
        let mut settings = Self::default();
        if let Some(v) = val.get("autoStartProtection").and_then(Value::as_bool) {
            settings.auto_start_protection = v;
        }
        if let Some(v) = val.get("perAppProxy").and_then(Value::as_bool) {
            settings.per_app_proxy = v;
        }
        if let Some(arr) = val.get("allowedApps").and_then(Value::as_array) {
            let parsed: Vec<String> = arr
                .iter()
                .filter_map(Value::as_str)
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty() && s.len() <= 128)
                .collect();
            if !parsed.is_empty() {
                settings.allowed_apps = parsed;
            }
        }
        settings
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let body = serde_json::to_string_pretty(&self.to_json()).map_err(|e| e.to_string())?;
        std::fs::write(path, body).map_err(|e| e.to_string())
    }

    pub fn apply_patch(&mut self, patch: &Value) -> Result<(), String> {
        let Some(obj) = patch.as_object() else {
            return Err("设置更新参数必须是对象。".into());
        };
        for (key, value) in obj {
            match key.as_str() {
                "autoStartProtection" => {
                    self.auto_start_protection =
                        value.as_bool().ok_or("autoStartProtection 必须是布尔值。")?;
                }
                "perAppProxy" => {
                    self.per_app_proxy = value.as_bool().ok_or("perAppProxy 必须是布尔值。")?;
                }
                "allowedApps" => {
                    let arr = value
                        .as_array()
                        .ok_or("allowedApps 必须是应用包名数组。")?;
                    let mut apps = Vec::with_capacity(arr.len());
                    for entry in arr {
                        let s = entry
                            .as_str()
                            .map(str::trim)
                            .filter(|s| !s.is_empty() && s.len() <= 128)
                            .ok_or("allowedApps 包含无效包名。")?;
                        apps.push(s.to_string());
                    }
                    self.allowed_apps = apps;
                }
                "openAtLogin" => {
                    // Mobile platforms do not support desktop login items; ignore false, reject true.
                    if value.as_bool() == Some(true) {
                        return Err("移动端不支持开机自启动，请使用系统 VPN 常驻配置。".into());
                    }
                }
                other => return Err(format!("不支持的移动端设置字段：{other}")),
            }
        }
        Ok(())
    }

    pub fn to_json(&self) -> Value {
        json!({
            "openAtLogin": false,
            "autoStartProtection": self.auto_start_protection,
            "canOpenAtLogin": false,
            "loginStatus": Value::Null,
            "platform": mobile_platform_name(),
            "perAppProxy": self.per_app_proxy,
            "allowedApps": self.allowed_apps,
        })
    }
}

pub fn mobile_platform_name() -> &'static str {
    #[cfg(target_os = "android")]
    {
        "android"
    }
    #[cfg(target_os = "ios")]
    {
        "ios"
    }
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        "desktop"
    }
}

/// Builds the initialization script injected into the mobile WebView so the shared
/// Next.js frontend receives dynamic loopback ports and mobile native capabilities.
pub fn mobile_bridge_script(helper_port: u16, gateway_port: u16, platform: &str) -> String {
    let ports = json!({ "helper": helper_port, "gateway": gateway_port });
    format!(
        r#"
      if (window === window.top) {{
        globalThis.__CHECKCC_PORTS__ = {ports};
        const callDesktop = (operation, patch) => window.__TAURI_INTERNALS__.invoke('desktop_call', {{ operation, patch }})
          .catch(error => {{ throw new Error(typeof error === 'string' ? error : error?.message || String(error)); }});
        const callMobile = (operation, params) => window.__TAURI_INTERNALS__.invoke('mobile_call', {{ operation, params }})
          .catch(error => {{ throw new Error(typeof error === 'string' ? error : error?.message || String(error)); }});
        if (!window.envGuardDesktop) Object.defineProperty(window, 'envGuardDesktop', {{ value: Object.freeze({{
          getSettings: () => callDesktop('getSettings'),
          updateSettings: patch => callDesktop('updateSettings', patch),
          resetClaude: () => callDesktop('resetClaude'),
          exportNodeSetupScript: () => callDesktop('exportNodeSetupScript')
        }}), writable: false, configurable: false }});
        if (!window.envGuardMobile) Object.defineProperty(window, 'envGuardMobile', {{ value: Object.freeze({{
          platform: '{platform}',
          getStatus: () => callMobile('getStatus'),
          startVpn: opts => callMobile('startVpn', opts),
          stopVpn: () => callMobile('stopVpn'),
          openProtectedBrowser: opts => callMobile('openProtectedBrowser', opts),
          openTimezoneSettings: () => callMobile('openTimezoneSettings'),
          setPorts: ports => callMobile('setPorts', ports)
        }}), writable: false, configurable: false }});
        window.dispatchEvent(new Event('envguardcc:ports-updated'));
        window.dispatchEvent(new Event('envguardcc:desktop-ready'));
      }}
    "#
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mobile_origins_allow_local_tauri_schemes_only() {
        for ok in [
            "tauri://localhost/index.html",
            "http://tauri.localhost/",
            "https://tauri.localhost/en/",
            "http://127.0.0.1:3030/",
        ] {
            assert!(
                is_trusted_mobile_origin("main", &ok.parse().unwrap()),
                "should accept {ok}"
            );
        }
        for bad in [
            "https://claude.ai/",
            "https://evil.example/",
            "http://tauri.localhost.evil/",
            "file:///index.html",
        ] {
            assert!(
                !is_trusted_mobile_origin("main", &bad.parse().unwrap()),
                "should reject {bad}"
            );
        }
        assert!(!is_trusted_mobile_origin(
            "protected-claude",
            &"tauri://localhost/".parse().unwrap()
        ));
    }

    #[test]
    fn protected_browser_allows_only_official_claude_https_urls() {
        assert!(is_allowed_protected_browser_url("https://claude.ai/new").is_ok());
        assert!(is_allowed_protected_browser_url("https://console.anthropic.com/").is_ok());
        assert!(is_allowed_protected_browser_url("http://claude.ai/").is_err());
        assert!(is_allowed_protected_browser_url("https://evil.example/").is_err());
        assert!(is_allowed_protected_browser_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn mobile_settings_patch_validates_fields() {
        let mut settings = MobileSettings::default();
        assert!(!settings.auto_start_protection);
        settings
            .apply_patch(&json!({ "autoStartProtection": true, "perAppProxy": true }))
            .unwrap();
        assert!(settings.auto_start_protection);
        assert!(settings.per_app_proxy);
        assert!(settings.apply_patch(&json!({ "openAtLogin": true })).is_err());
        assert!(settings.apply_patch(&json!({ "unknown": 1 })).is_err());
    }
}
