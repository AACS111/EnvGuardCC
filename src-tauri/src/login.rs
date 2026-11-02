use serde_json::{json, Value};

#[cfg(windows)]
pub fn read(app: &tauri::AppHandle) -> Result<Value, String> {
    use tauri_plugin_autostart::ManagerExt;
    Ok(
        json!({"openAtLogin": app.autolaunch().is_enabled().map_err(|e| e.to_string())?, "status": null}),
    )
}

#[cfg(windows)]
pub fn set(app: &tauri::AppHandle, enabled: bool) -> Result<Value, String> {
    use tauri_plugin_autostart::ManagerExt;
    if enabled {
        app.autolaunch().enable()
    } else {
        app.autolaunch().disable()
    }
    .map_err(|e| e.to_string())?;
    read(app)
}

// Electron uses SMAppService.mainApp on macOS 13+. Reuse that registration so an
// upgrade preserves OS approval and disabling startup also disables the old entry.
#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use objc::{
        class, msg_send,
        runtime::{Object, BOOL, NO},
        sel, sel_impl,
    };
    use std::{ffi::CStr, ptr::null_mut};

    #[link(name = "ServiceManagement", kind = "framework")]
    extern "C" {}

    unsafe fn service() -> *mut Object {
        msg_send![class!(SMAppService), mainAppService]
    }

    pub fn was_opened_at_login() -> bool {
        objc::rc::autoreleasepool(|| unsafe {
            let manager: *mut Object =
                msg_send![class!(NSAppleEventManager), sharedAppleEventManager];
            let event: *mut Object = msg_send![manager, currentAppleEvent];
            if event.is_null() {
                return false;
            }
            let event_id: u32 = msg_send![event, eventID];
            let data: *mut Object =
                msg_send![event, paramDescriptorForKeyword: u32::from_be_bytes(*b"prdt")];
            if data.is_null() {
                return false;
            }
            let value: u32 = msg_send![data, enumCodeValue];
            event_id == u32::from_be_bytes(*b"oapp") && value == u32::from_be_bytes(*b"lgit")
        })
    }

    pub fn read() -> Result<Value, String> {
        objc::rc::autoreleasepool(|| unsafe {
            let service = service();
            if service.is_null() {
                return Err("系统登录项服务不可用。".into());
            }
            let status: isize = msg_send![service, status];
            let name = match status {
                0 => "not-registered",
                1 => "enabled",
                2 => "requires-approval",
                _ => "not-found",
            };
            Ok(json!({"openAtLogin": status == 1, "status": name}))
        })
    }

    pub fn set(enabled: bool) -> Result<Value, String> {
        objc::rc::autoreleasepool(|| unsafe {
            let service = service();
            if service.is_null() {
                return Err("系统登录项服务不可用。".into());
            }
            let mut error: *mut Object = null_mut();
            let accepted: BOOL = if enabled {
                msg_send![service, registerAndReturnError: &mut error]
            } else {
                msg_send![service, unregisterAndReturnError: &mut error]
            };
            if accepted == NO {
                if !error.is_null() {
                    let description: *mut Object = msg_send![error, localizedDescription];
                    let text: *const std::ffi::c_char = msg_send![description, UTF8String];
                    if !text.is_null() {
                        return Err(CStr::from_ptr(text).to_string_lossy().into_owned());
                    }
                }
                return Err("系统拒绝自启动设置。".into());
            }
            read()
        })
    }
}

#[cfg(target_os = "macos")]
pub fn read(_: &tauri::AppHandle) -> Result<Value, String> {
    mac::read()
}
#[cfg(target_os = "macos")]
pub fn set(_: &tauri::AppHandle, enabled: bool) -> Result<Value, String> {
    mac::set(enabled)
}

pub fn was_opened_at_login() -> bool {
    #[cfg(target_os = "macos")]
    {
        mac::was_opened_at_login()
    }
    #[cfg(not(target_os = "macos"))]
    {
        false
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
pub fn read(_: &tauri::AppHandle) -> Result<Value, String> {
    Ok(json!({"openAtLogin": false, "status": null}))
}
#[cfg(not(any(windows, target_os = "macos")))]
pub fn set(_: &tauri::AppHandle, _: bool) -> Result<Value, String> {
    Err("当前平台不支持自启动。".into())
}
