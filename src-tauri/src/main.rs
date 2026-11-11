#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod login;
mod power;

use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs::{File, OpenOptions},
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
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

const BACKEND_LOG_LIMIT: u64 = 8 * 1024 * 1024;

/// 打包版是 windows_subsystem 进程，没有控制台，stderr 会被直接丢弃。
/// 不落盘就只能看到“后台已退出”而永远查不到原因，所以统一追加到用户目录日志。
fn open_backend_log(user_data: &Path) -> Option<File> {
    let directory = user_data.join("logs");
    std::fs::create_dir_all(&directory).ok()?;
    let path = directory.join("backend.log");
    if std::fs::metadata(&path)
        .map(|meta| meta.len() > BACKEND_LOG_LIMIT)
        .unwrap_or(false)
    {
        let _ = std::fs::rename(&path, directory.join("backend.log.1"));
    }
    OpenOptions::new().create(true).append(true).open(path).ok()
}

/// 只为日志行提供可读时间戳，避免为一个格式化引入额外依赖。
fn iso_format(seconds: i64, millis: u32) -> String {
    let days = seconds.div_euclid(86_400);
    let clock = seconds.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        clock / 3600,
        clock % 3600 / 60,
        clock % 60
    )
}

fn iso_now() -> String {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    iso_format(now.as_secs() as i64, now.subsec_millis())
}

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
    log: Mutex<Option<File>>,
    log_path: Mutex<Option<PathBuf>>,
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

    fn attach_log(&self, file: Option<File>, path: &Path) {
        if file.is_some() {
            *self.log_path.lock().unwrap() = Some(path.to_path_buf());
        }
        *self.log.lock().unwrap() = file;
    }

    fn log_hint(&self) -> String {
        self.log_path
            .lock()
            .unwrap()
            .as_ref()
            .map(|path| path.display().to_string())
            .unwrap_or_else(|| "日志文件不可用".into())
    }

    /// 关键事件必须留证；写日志失败也要继续走恢复流程，不能反过来影响退出。
    fn note(&self, line: &str) {
        eprintln!("[desktop] {line}");
        let mut log = self.log.lock().unwrap();
        if let Some(file) = log.as_mut() {
            let _ = writeln!(file, "{} [host] {line}", iso_now());
            let _ = file.flush();
        }
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
    backend.note("收到退出请求，开始恢复配置。");
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_enabled(false);
        let _ = window.set_title("EnvGuardCC · 正在自动恢复配置…");
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        match backend.request("shutdown", Value::Null).await {
            Ok(_) => {
                backend.note("配置已恢复，退出应用。");
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
                backend.note(&format!("自动恢复未完成：{error}"));
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
    // 打包版没有控制台，stderr 无处可去；落盘后崩溃与配置残留才有据可查。
    let log_file = open_backend_log(&user_data);
    let log_path = user_data.join("logs").join("backend.log");
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
        .stdout(Stdio::piped());
    if development {
        // 开发版保留终端实时输出；后台仍会把结构化日志写进同一个文件。
        command.stderr(Stdio::inherit());
    } else if let Some(file) = log_file.as_ref().and_then(|file| file.try_clone().ok()) {
        command.stderr(Stdio::from(file));
        command.env("CHECKCC_BACKEND_LOG", &log_path);
    } else {
        command.stderr(Stdio::null());
    }
    if development {
        command.env("CHECKCC_DESKTOP_DEV_URL", origin());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW: never show a Node console.
    }
    let mut child = command.spawn()?;
    backend.attach_log(log_file, &log_path);
    backend.note(&format!("后台已启动（pid={}）。", child.id()));
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
        // EOF 只说明进程不在了；留下退出码才能区分崩溃、被杀和正常退出。
        // 先把子进程取出，避免 wait() 期间占着 child 锁阻塞退出流程。
        let child = reader_backend.child.lock().unwrap().take();
        let code = child
            .and_then(|mut child| child.wait().ok())
            .and_then(|status| status.code());
        let status = code
            .map(|code| format!("code={code}"))
            .unwrap_or_else(|| "退出码不可读".into());
        reader_backend.note(&format!("后台进程已退出（{status}）。"));
        if let Some(tx) = ready.take() {
            let _ = tx.send(Err("后台在启动时退出。".into()));
        }
        if !reader_backend.quitting.load(Ordering::SeqCst) {
            let message = format!(
                "本机后台已退出。原始备份已保留，请重新启动应用以恢复配置。\n\n退出码：{status}\n日志：{}",
                reader_backend.log_hint()
            );
            app_reader
                .dialog()
                .message(message)
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
    fn backend_log_timestamps_are_utc_iso() {
        assert_eq!(iso_format(0, 0), "1970-01-01T00:00:00.000Z");
        // 2000-02-29 00:00:00Z：覆盖闰年分支。
        assert_eq!(iso_format(951_782_400, 7), "2000-02-29T00:00:00.007Z");
        assert_eq!(iso_format(1_800_000_000, 250), "2027-01-15T08:00:00.250Z");
    }

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
    backend.note(&format!("后台启动失败：{error}"));
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
                "{error}\n请确认应用端口 3030 未被占用。原始备份已保留。\n\n日志：{}",
                backend.log_hint()
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
                MenuItem::with_id(app, "show", "显示主界面", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(
                app,
                "quit",
                "退出",
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
