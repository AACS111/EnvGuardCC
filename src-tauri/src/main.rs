#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod login;
mod power;

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindow,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tokio::sync::oneshot;

fn origin() -> &'static str {
    static ORIGIN: OnceLock<String> = OnceLock::new();
    ORIGIN.get_or_init(|| {
        let port = if std::env::var("CHECKCC_DESKTOP_SMOKE").as_deref() == Ok("1") {
            std::env::var("CHECKCC_DESKTOP_SMOKE_PORT")
                .ok()
                .and_then(|p| p.parse::<u16>().ok())
                .filter(|p| *p > 0)
                .unwrap_or(3030)
        } else {
            3030
        };
        format!("http://127.0.0.1:{port}")
    })
}
type Reply = oneshot::Sender<Result<Value, String>>;

#[derive(Default)]
struct Backend {
    input: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<u64, Reply>>,
    next: AtomicU64,
    stopping: AtomicBool,
    quitting: AtomicBool,
    dead: AtomicBool,
    has_tray: AtomicBool,
}

impl Backend {
    fn send(&self, message: &Value) -> Result<(), String> {
        let mut input = self.input.lock().unwrap();
        let writer = input.as_mut().ok_or("后台连接不可用。")?;
        writeln!(writer, "{message}")
            .and_then(|_| writer.flush())
            .map_err(|e| e.to_string())
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, String> {
        if self.dead.load(Ordering::SeqCst) {
            return Err("后台已退出，原始备份已保留。".into());
        }
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if let Err(error) =
            self.send(&json!({"type":"request", "id":id, "method":method, "params":params}))
        {
            self.pending.lock().unwrap().remove(&id);
            return Err(error);
        }
        let result = tokio::time::timeout(Duration::from_secs(150), rx).await;
        self.pending.lock().unwrap().remove(&id);
        result
            .map_err(|_| "后台操作超时，配置备份已保留。".to_string())?
            .map_err(|_| "后台连接已断开。".to_string())?
    }
}

fn show(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn check_window(window: &WebviewWindow) -> Result<(), String> {
    let url = window.url().map_err(|e| e.to_string())?;
    if !trusted_url(window.label(), &url) {
        return Err("拒绝非主窗口的桌面请求。".into());
    }
    Ok(())
}

fn trusted_url(label: &str, url: &tauri::Url) -> bool {
    label == "main" && url.origin().ascii_serialization() == origin()
}

#[tauri::command]
async fn desktop_call(
    window: WebviewWindow,
    backend: tauri::State<'_, Arc<Backend>>,
    operation: String,
    patch: Option<Value>,
) -> Result<Value, String> {
    check_window(&window)?;
    if backend.stopping.load(Ordering::SeqCst) {
        return Err("应用正在恢复配置，请稍候。".into());
    }
    if !matches!(
        operation.as_str(),
        "getSettings" | "updateSettings" | "resetClaude"
    ) {
        return Err("不支持的桌面操作。".into());
    }
    backend
        .request(&operation, patch.unwrap_or(Value::Null))
        .await
}

#[tauri::command]
async fn smoke_result(
    window: WebviewWindow,
    app: tauri::AppHandle,
    backend: tauri::State<'_, Arc<Backend>>,
    mut result: Value,
) -> Result<(), String> {
    check_window(&window)?;
    if std::env::var("CHECKCC_DESKTOP_SMOKE").as_deref() != Ok("1") {
        return Err("未启用测试模式。".into());
    }
    let page_url = window.url().map_err(|e| e.to_string())?;
    result["tauriDevMode"] = json!(tauri::is_dev());
    result["frontendMatchesPage"] = json!(matches!(
        app.config().build.frontend_dist.as_ref(),
        Some(tauri::utils::config::FrontendDist::Url(url)) if url.make_relative(&page_url).is_some()
    ));
    let file = std::env::var_os("CHECKCC_SMOKE_REPORT").ok_or("缺少测试报告路径。")?;
    std::fs::write(file, serde_json::to_vec_pretty(&result).unwrap()).map_err(|e| e.to_string())?;
    quit(&app, backend.inner().clone());
    Ok(())
}

fn quit(app: &tauri::AppHandle, backend: Arc<Backend>) {
    if backend.stopping.swap(true, Ordering::SeqCst) {
        return;
    }
    if backend.dead.load(Ordering::SeqCst) {
        backend.quitting.store(true, Ordering::SeqCst);
        app.exit(1);
        return;
    }
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_enabled(false);
        let _ = window.set_title("EnvGuardCC · 正在自动恢复配置…");
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match backend.request("shutdown", Value::Null).await {
            Ok(_) => {
                backend.quitting.store(true, Ordering::SeqCst);
                backend.input.lock().unwrap().take();
                let child = backend.child.lock().unwrap().take();
                // EOF lets Node finish its restoration handler and exit; always reap it.
                if let Some(mut child) = child {
                    let _ = tauri::async_runtime::spawn_blocking(move || child.wait()).await;
                }
                app.exit(0);
            }
            Err(error) => {
                backend.stopping.store(false, Ordering::SeqCst);
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.set_enabled(true);
                    let _ = window.set_title("EnvGuardCC · 配置恢复未完成");
                    let _ = window.show();
                }
                app.dialog()
                    .message(format!(
                        "原始备份已保留。请检查权限或连接，随后再次退出。\n\n{error}"
                    ))
                    .title("自动恢复未完成")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        }
    });
}

fn native(
    app: &tauri::AppHandle,
    method: &str,
    params: &Value,
    development: bool,
) -> Result<Value, String> {
    match method {
        "get_login" => {
            if development {
                Ok(json!({"openAtLogin": false, "status": null}))
            } else {
                login::read(app)
            }
        }
        "set_login" => {
            if development {
                return Err("开发模式不注册系统自启动。".into());
            }
            let enabled = params["enabled"].as_bool().ok_or("无效的自启动设置。")?;
            login::set(app, enabled)
        }
        "confirm_reset" => {
            let paths = params["paths"].as_array().ok_or("无效的重置预览。")?;
            let detail = paths
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join("\n");
            Ok(json!(app.dialog().message(format!("重置 Claude 桌面客户端的本地数据？\n\n将清除下列位置的登录状态、缓存、设置、MCP 配置及本地 Cowork/桌面会话数据。云端聊天和账号记录、浏览器及 Claude Code 数据不受影响。\n\n数据将移至系统废纸篓/回收站，未清空前仍可恢复。不会修改设备标识或保证解除账号关联。\n\n{detail}"))
                .title("Claude 恢复初始化").kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom("恢复初始化".into(), "取消".into())).blocking_show()))
        }
        // Only the trusted child calls this, after createClaudeReset revalidates its approved plan.
        "trash" => {
            let path = params["path"].as_str().ok_or("缺少回收站路径。")?;
            trash::delete(path).map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        _ => Err("不支持的原生操作。".into()),
    }
}

fn bridge(ports: &Value) -> String {
    let origin = origin();
    format!(
        r#"
      if (location.origin === '{origin}' && window === window.top) {{
        globalThis.__CHECKCC_PORTS__ = {ports};
        const call = (operation, patch) => window.__TAURI_INTERNALS__.invoke('desktop_call', {{ operation, patch }})
          .catch(error => {{ throw new Error(typeof error === 'string' ? error : error?.message || String(error)); }});
        if (!window.envGuardDesktop) Object.defineProperty(window, 'envGuardDesktop', {{ value: Object.freeze({{
          getSettings: () => call('getSettings'),
          updateSettings: patch => call('updateSettings', patch),
          resetClaude: () => call('resetClaude')
        }}), writable: false, configurable: false }});
        window.dispatchEvent(new Event('envguardcc:desktop-ready'));
      }}
    "#
    )
}

fn start(app: &tauri::AppHandle, backend: Arc<Backend>) -> Result<(), Box<dyn std::error::Error>> {
    let development = cfg!(debug_assertions);
    // Capture the launch AppleEvent before asynchronous backend startup completes.
    let login_launch =
        std::env::args().any(|arg| arg == "--envguardcc-login") || login::was_opened_at_login();
    let root = if development {
        PathBuf::from(
            std::env::var_os("CHECKCC_DESKTOP_RESOURCE_ROOT")
                .ok_or("请使用 pnpm dev:tauri 启动开发版。")?,
        )
    } else {
        app.path().resource_dir()?.join("backend")
    };
    // Tauri may return \\?\ paths; Node's module resolver requires ordinary Win32 paths.
    let root = dunce::simplified(&root).to_path_buf();
    let node = if development {
        PathBuf::from(std::env::var_os("CHECKCC_NODE_EXECUTABLE").ok_or("缺少开发 Node 路径。")?)
    } else {
        root.join("runtime")
            .join(if cfg!(windows) { "node.exe" } else { "node" })
    };
    let user_data = std::env::var_os("CHECKCC_DESKTOP_USER_DATA")
        .map(PathBuf::from)
        .unwrap_or(
            app.path()
                .config_dir()?
                .join(if development { "check-cc" } else { "CheckCC" }),
        );
    let user_data = dunce::simplified(&user_data).to_path_buf();
    std::fs::create_dir_all(&user_data)?;
    let mut command = Command::new(node);
    // Node cannot resolve all verbatim Windows resource paths as absolute entrypoints.
    command
        .arg("desktop/backend.mjs")
        .current_dir(&root)
        .env("CHECKCC_DESKTOP_USER_DATA", &user_data)
        .env(
            "CHECKCC_DESKTOP_SITE_PORT",
            origin().rsplit(':').next().unwrap(),
        )
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    if development {
        command.env("CHECKCC_DESKTOP_DEV_URL", origin());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW: never show a Node console.
    }
    let mut child = command.spawn()?;
    let output = child.stdout.take().ok_or("缺少后台输出管道。")?;
    *backend.input.lock().unwrap() = child.stdin.take();
    *backend.child.lock().unwrap() = Some(child);
    let (ready_tx, ready_rx) = oneshot::channel();
    let app_reader = app.clone();
    let reader_backend = backend.clone();
    std::thread::spawn(move || {
        let mut ready = Some(ready_tx);
        for line in BufReader::new(output).lines() {
            let Ok(line) = line else {
                break;
            };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            match message["type"].as_str() {
                Some("response") => {
                    if let Some(id) = message["id"].as_u64() {
                        if let Some(tx) = reader_backend.pending.lock().unwrap().remove(&id) {
                            let result = if let Some(error) = message["error"].as_str() {
                                Err(error.into())
                            } else {
                                Ok(message["result"].clone())
                            };
                            let _ = tx.send(result);
                        }
                    }
                }
                Some("request") => {
                    let app = app_reader.clone();
                    let backend = reader_backend.clone();
                    std::thread::spawn(move || {
                        let result = native(
                            &app,
                            message["method"].as_str().unwrap_or(""),
                            &message["params"],
                            development,
                        );
                        let reply = match result {
                            Ok(result) => {
                                json!({"type":"response", "id":message["id"], "result":result})
                            }
                            Err(error) => {
                                json!({"type":"response", "id":message["id"], "error":error})
                            }
                        };
                        let _ = backend.send(&reply);
                    });
                }
                Some("ready") => {
                    if let Some(tx) = ready.take() {
                        let _ = tx.send(Ok(message));
                    }
                }
                Some("failed") => {
                    if let Some(tx) = ready.take() {
                        let _ = tx.send(Err(message["error"]
                            .as_str()
                            .unwrap_or("后台启动失败。")
                            .to_string()));
                    }
                }
                Some("power") => power::set_active(message["enabled"].as_bool().unwrap_or(false)),
                _ => {}
            }
        }
        reader_backend.dead.store(true, Ordering::SeqCst);
        reader_backend.pending.lock().unwrap().clear();
        if let Some(tx) = ready.take() {
            let _ = tx.send(Err("后台在启动时退出。".into()));
        }
        if !reader_backend.quitting.load(Ordering::SeqCst) {
            app_reader
                .dialog()
                .message("本机后台已退出。原始备份已保留，请重新启动应用以恢复配置。")
                .title("EnvGuardCC 后台已退出")
                .kind(MessageDialogKind::Error)
                .show(|_| {});
        }
    });
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = tokio::time::timeout(Duration::from_secs(180), ready_rx).await;
        let ready = match result {
            Ok(Ok(Ok(value))) => value,
            other => {
                let message = match other {
                    Ok(Ok(Err(error))) => error,
                    _ => "后台启动超时或连接中断。".into(),
                };
                startup_error(&app, backend, message);
                return;
            }
        };
        if ready["url"].as_str() != Some(origin()) {
            startup_error(&app, backend, "后台页面来源无效。".into());
            return;
        }
        let handle = app.clone();
        let builder = tauri::WebviewWindowBuilder::new(
            &app,
            "main",
            WebviewUrl::External(origin().parse().unwrap()),
        )
        .title("EnvGuardCC")
        .inner_size(1440.0, 1000.0)
        .min_inner_size(420.0, 640.0)
        .visible(false)
        .initialization_script(bridge(&ready["ports"]))
        .on_page_load({
            let ports = ready["ports"].clone();
            move |window, payload| {
                if payload.event() == tauri::webview::PageLoadEvent::Finished
                    && trusted_url(window.label(), payload.url())
                {
                    // Retry after navigation has committed so early renderer reads can recover.
                    let _ = window.eval(bridge(&ports));
                    if std::env::var("CHECKCC_DESKTOP_SMOKE").as_deref() == Ok("1") {
                        let _ = window.eval(include_str!("../../desktop/smoke.js"));
                    }
                }
            }
        })
        .on_navigation(move |url| {
            if trusted_url("main", url) {
                return true;
            }
            if matches!(url.scheme(), "http" | "https") {
                let _ = open::that(url.as_str());
            }
            false
        })
        .on_new_window(|url, _| {
            if matches!(url.scheme(), "http" | "https") {
                let _ = open::that(url.as_str());
            }
            tauri::webview::NewWindowResponse::Deny
        });
        #[cfg(windows)]
        let builder = builder.data_directory(user_data.join("webview"));
        let result = builder.build();
        match result {
            Ok(window) => {
                if (!login_launch || !backend.has_tray.load(Ordering::SeqCst))
                    && std::env::var("CHECKCC_DESKTOP_SMOKE").as_deref() != Ok("1")
                {
                    let _ = window.show();
                }
                if backend.stopping.load(Ordering::SeqCst) {
                    quit(&handle, backend);
                }
            }
            Err(error) => startup_error(&app, backend, error.to_string()),
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn desktop_permissions_require_exact_main_window_origin() {
        assert!(trusted_url(
            "main",
            &format!("{}/en/", origin()).parse().unwrap()
        ));
        assert!(!trusted_url("secondary", &origin().parse().unwrap()));
        for url in [
            "http://localhost:3030",
            "http://127.0.0.1:9999",
            "https://127.0.0.1:3030",
            "http://127.0.0.1.evil:3030",
            "file:///index.html",
            "https://example.com",
        ] {
            assert!(
                !trusted_url("main", &url.parse().unwrap()),
                "accepted {url}"
            );
        }
    }
}

fn startup_error(app: &tauri::AppHandle, backend: Arc<Backend>, error: String) {
    eprintln!("[desktop] {error}");
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let _ = backend.request("shutdown", Value::Null).await;
        backend.quitting.store(true, Ordering::SeqCst);
        backend.input.lock().unwrap().take();
        if std::env::var("CHECKCC_DESKTOP_SMOKE").as_deref() == Ok("1") {
            if let Some(file) = std::env::var_os("CHECKCC_SMOKE_REPORT") {
                let _ = std::fs::write(file, json!({"passed": false, "error": error}).to_string());
            }
            app.exit(1);
            return;
        }
        let app_exit = app.clone();
        app.dialog()
            .message(format!(
                "{error}\n请确认应用端口 3030 未被占用。原始备份已保留。"
            ))
            .title("EnvGuardCC 启动失败")
            .kind(MessageDialogKind::Error)
            .show(move |_| app_exit.exit(1));
    });
}

fn main() {
    let backend = Arc::new(Backend::default());
    let setup_backend = backend.clone();
    let autostart = tauri_plugin_autostart::Builder::new()
        .app_name("EnvGuardCC")
        .args(["--envguardcc-login"]);
    #[cfg(target_os = "macos")]
    let autostart = autostart.macos_launcher(tauri_plugin_autostart::MacosLauncher::LaunchAgent);
    let mut context = tauri::generate_context!();
    if std::env::var("CHECKCC_DESKTOP_SMOKE").as_deref() == Ok("1")
        && std::env::var_os("CHECKCC_DESKTOP_USER_DATA").is_some()
        && std::env::var_os("CHECKCC_SMOKE_REPORT").is_some()
    {
        // Keep the production plugin chain, but isolate the test instance's mutex.
        context
            .config_mut()
            .identifier
            .push_str(&format!(".smoke{}", std::process::id()));
        if std::env::var("CHECKCC_DESKTOP_SMOKE_ACL_MODE").as_deref() != Ok("remote") {
            // Match the configured frontend URL to exercise Origin::Local, exactly
            // like production port 3030, while leaving the user's listener alone.
            context.config_mut().build.frontend_dist = Some(
                tauri::utils::config::FrontendDist::Url(origin().parse().unwrap()),
            );
        }
    }
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| show(app)))
        .plugin(autostart.build())
        .plugin(tauri_plugin_dialog::init())
        .manage(backend.clone())
        .invoke_handler(tauri::generate_handler![desktop_call, smoke_result])
        .setup(move |app| {
            app.add_capability(
                tauri::ipc::CapabilityBuilder::new("main-local-page")
                    // frontendDist's HTTP URL is classified as local by Tauri.
                    // Remote origins still need the exact match below;
                    // desktop_call also enforces main-window + exact-origin checks.
                    .local(true)
                    .window("main")
                    .remote(format!("{}/*", origin()))
                    .permission("allow-desktop-call"),
            )?;
            power::start(app.handle().clone());
            let show_item =
                MenuItem::with_id(app, "show", "显示主窗口 / Show window", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(
                app,
                "quit",
                "退出并恢复配置 / Quit and restore",
                true,
                None::<&str>,
            )?;
            let menu = Menu::with_items(app, &[&show_item, &quit_item])?;
            let tray_backend = setup_backend.clone();
            let tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("EnvGuardCC")
                .menu(&menu)
                .on_menu_event(move |app, event| match event.id.as_ref() {
                    "show" => show(app),
                    "quit" => quit(app, tray_backend.clone()),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if matches!(
                        event,
                        TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        }
                    ) {
                        show(tray.app_handle());
                    }
                })
                .build(app);
            setup_backend.has_tray.store(tray.is_ok(), Ordering::SeqCst);
            if let Err(error) = tray {
                eprintln!("[desktop] 无法创建托盘，将使用任务栏最小化：{error}");
            }
            if let Err(error) = start(app.handle(), setup_backend.clone()) {
                startup_error(app.handle(), setup_backend.clone(), error.to_string());
            }
            if let Some(file) = std::env::var_os("CHECKCC_DESKTOP_QUIT_FILE") {
                let app = app.handle().clone();
                let backend = setup_backend.clone();
                std::thread::spawn(move || {
                    while !backend.quitting.load(Ordering::SeqCst) {
                        if std::path::Path::new(&file).exists() {
                            quit(&app, backend.clone());
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(250));
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<Arc<Backend>>();
                if !state.quitting.load(Ordering::SeqCst) {
                    api.prevent_close();
                    if !state.stopping.load(Ordering::SeqCst) {
                        if state.has_tray.load(Ordering::SeqCst) {
                            let _ = window.hide();
                        } else {
                            let _ = window.minimize();
                        }
                    }
                }
            }
        })
        .build(context)
        .expect("无法初始化 EnvGuardCC");
    app.run(move |app, event| match event {
        tauri::RunEvent::ExitRequested { api, .. } if !backend.quitting.load(Ordering::SeqCst) => {
            api.prevent_exit();
            quit(app, backend.clone());
        }
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => show(app),
        tauri::RunEvent::Exit => {
            power::set_active(false);
            backend.input.lock().unwrap().take();
        }
        _ => {}
    });
}
