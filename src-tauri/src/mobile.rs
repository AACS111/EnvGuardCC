use crate::mobile_common::{
    is_allowed_protected_browser_url, is_trusted_mobile_origin, mobile_bridge_script,
    mobile_platform_name, MobileSettings,
};
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicU16, Ordering},
        Mutex,
    },
};
use tauri::{Manager, WebviewUrl, WebviewWindow};

const DEFAULT_MOBILE_HELPER_PORT: u16 = 39081;
const DEFAULT_MOBILE_GATEWAY_PORT: u16 = 39082;
const RUNTIME_POLICY_JS: &str = include_str!("../../src/detection/runtime-policy.mjs");

struct MobileState {
    settings_path: PathBuf,
    settings: Mutex<MobileSettings>,
    helper_port: AtomicU16,
    gateway_port: AtomicU16,
}

impl MobileState {
    fn new(app_data_dir: PathBuf) -> Self {
        let settings_path = app_data_dir.join("mobile-settings.json");
        let settings = MobileSettings::load(&settings_path);
        Self {
            settings_path,
            settings: Mutex::new(settings),
            helper_port: AtomicU16::new(DEFAULT_MOBILE_HELPER_PORT),
            gateway_port: AtomicU16::new(DEFAULT_MOBILE_GATEWAY_PORT),
        }
    }

    fn ports(&self) -> (u16, u16) {
        (
            self.helper_port.load(Ordering::SeqCst),
            self.gateway_port.load(Ordering::SeqCst),
        )
    }

    fn set_ports(&self, helper: u16, gateway: u16) {
        if helper >= 1024 {
            self.helper_port.store(helper, Ordering::SeqCst);
        }
        if gateway >= 1024 {
            self.gateway_port.store(gateway, Ordering::SeqCst);
        }
    }
}

fn check_mobile_window(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    if !is_trusted_mobile_origin(window.label(), &url) {
        return Err("拒绝非主窗口的移动端调用。".into());
    }
    Ok(())
}

/// Converts the ESM `runtime-policy.mjs` module into an inline IIFE suitable for
/// WebView initialization script injection inside the in-app protected browser.
fn protected_browser_init_script(policy: &Value) -> String {
    let serialized_policy = serde_json::to_string(policy).unwrap_or_else(|_| "{}".into());
    let inline_module = RUNTIME_POLICY_JS
        .replace("export function ", "function ")
        .replace("export const ", "const ");
    format!(
        r#"
        (() => {{
          try {{
            {inline_module}
            const policy = {serialized_policy};
            if (typeof installRuntimePolicy === 'function' && policy && typeof policy === 'object') {{
              installRuntimePolicy(policy);
            }}
          }} catch (e) {{
            console.warn('[EnvGuardCC] mobile protected browser cloak init failed:', e);
          }}
        }})();
        "#
    )
}

#[tauri::command]
async fn desktop_call(
    window: WebviewWindow,
    state: tauri::State<'_, MobileState>,
    operation: String,
    patch: Option<Value>,
) -> Result<Value, String> {
    check_mobile_window(&window)?;
    match operation.as_str() {
        "getSettings" => Ok(state.settings.lock().unwrap().to_json()),
        "updateSettings" => {
            let mut settings = state.settings.lock().unwrap();
            settings.apply_patch(&patch.unwrap_or(Value::Null))?;
            settings.save(&state.settings_path)?;
            Ok(settings.to_json())
        }
        "resetClaude" => Err(
            "移动端无法访问外部应用沙盒数据；请在系统设置 → 应用管理中手动清理 Claude 应用数据。"
                .into(),
        ),
        "exportNodeSetupScript" => Err("移动端暂不支持直接导出脚本文件，请复制安装命令。".into()),
        _ => Err("不支持的操作。".into()),
    }
}

#[tauri::command]
async fn mobile_call(
    window: WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, MobileState>,
    operation: String,
    params: Option<Value>,
) -> Result<Value, String> {
    check_mobile_window(&window)?;
    let params = params.unwrap_or(Value::Null);
    match operation.as_str() {
        "getStatus" => {
            let (helper, gateway) = state.ports();
            Ok(json!({
                "platform": mobile_platform_name(),
                "helperPort": helper,
                "gatewayPort": gateway,
                "settings": state.settings.lock().unwrap().to_json(),
            }))
        }
        "setPorts" => {
            let helper = params
                .get("helper")
                .and_then(Value::as_u64)
                .and_then(|v| u16::try_from(v).ok())
                .unwrap_or(DEFAULT_MOBILE_HELPER_PORT);
            let gateway = params
                .get("gateway")
                .and_then(Value::as_u64)
                .and_then(|v| u16::try_from(v).ok())
                .unwrap_or(DEFAULT_MOBILE_GATEWAY_PORT);
            state.set_ports(helper, gateway);
            let script = mobile_bridge_script(helper, gateway, mobile_platform_name());
            let _ = window.eval(&script);
            Ok(json!({ "ok": true, "helper": helper, "gateway": gateway }))
        }
        "openProtectedBrowser" => {
            let raw_url = params
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("https://claude.ai");
            let url = is_allowed_protected_browser_url(raw_url)?;
            let policy = params.get("policy").cloned().unwrap_or_else(|| json!({}));
            if let Some(existing) = app.get_webview_window("protected-claude") {
                let _ = existing.close();
            }
            let init_script = protected_browser_init_script(&policy);
            tauri::WebviewWindowBuilder::new(&app, "protected-claude", WebviewUrl::External(url))
                .initialization_script(&init_script)
                .build()
                .map_err(|e| format!("无法打开内置保护浏览器：{e}"))?;
            Ok(json!({ "ok": true, "opened": true }))
        }
        "openTimezoneSettings" => Ok(json!({
            "ok": false,
            "manualRequired": true,
            "platform": mobile_platform_name(),
            "message": if cfg!(target_os = "android") {
                "请前往「系统设置 → 系统 → 日期和时间」关闭自动时区并手动选择目标时区。"
            } else {
                "iOS 禁止第三方应用修改系统时区，请前往「设置 → 通用 → 日期与时间」手动调整。"
            }
        })),
        "startVpn" | "stopVpn" => {
            // Native Android VpnService / iOS NEPacketTunnelProvider listens to the Go core
            // control plane; return a clear status if native VPN bridge hasn't attached yet.
            let (helper, gateway) = state.ports();
            Ok(json!({
                "ok": true,
                "delegatedToCore": true,
                "operation": operation,
                "helperPort": helper,
                "gatewayPort": gateway,
            }))
        }
        _ => Err(format!("不支持的移动端操作：{operation}")),
    }
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![desktop_call, mobile_call])
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .unwrap_or_else(|_| PathBuf::from("."));
            let _ = std::fs::create_dir_all(&data_dir);
            let state = MobileState::new(data_dir);
            let (helper, gateway) = state.ports();
            app.manage(state);
            app.add_capability(
                tauri::ipc::CapabilityBuilder::new("mobile-local-page")
                    .local(true)
                    .window("main")
                    .permission("allow-mobile-call"),
            )?;
            if let Some(window) = app.get_webview_window("main") {
                let script = mobile_bridge_script(helper, gateway, mobile_platform_name());
                let _ = window.eval(&script);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("无法初始化 EnvGuardCC 移动端");
}
