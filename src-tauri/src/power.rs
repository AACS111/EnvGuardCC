use std::sync::{
    atomic::{AtomicBool, Ordering},
    OnceLock,
};
use tauri::Manager;

static ACTIVE: AtomicBool = AtomicBool::new(false);
static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

pub fn set_active(active: bool) {
    ACTIVE.store(active, Ordering::SeqCst);
}
fn wake() {
    if let Some(window) = APP.get().and_then(|app| app.get_webview_window("main")) {
        let _ = window.eval("window.dispatchEvent(new Event('checkcc:resume'))");
    }
}
pub fn start(app: tauri::AppHandle) {
    let _ = APP.set(app);
    #[cfg(target_os = "macos")]
    unsafe {
        mac_observers();
    }
    std::thread::spawn(platform_loop);
}

#[cfg(windows)]
fn platform_loop() {
    use std::{ptr::null, thread, time::Duration};
    use windows_sys::Win32::{
        System::{
            LibraryLoader::GetModuleHandleW,
            Power::{SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED},
            RemoteDesktop::{WTSRegisterSessionNotification, WTSUnRegisterSessionNotification},
        },
        UI::WindowsAndMessaging::*,
    };
    unsafe extern "system" fn procedure(
        hwnd: windows_sys::Win32::Foundation::HWND,
        message: u32,
        w: usize,
        l: isize,
    ) -> isize {
        if (message == WM_POWERBROADCAST && matches!(w, 7 | 18))
            || (message == WM_WTSSESSION_CHANGE && w == 8)
        {
            wake();
        }
        unsafe { DefWindowProcW(hwnd, message, w, l) }
    }
    unsafe {
        let class: Vec<u16> = "EnvGuardCCPower\0".encode_utf16().collect();
        let instance = GetModuleHandleW(null());
        let wc = WNDCLASSW {
            lpfnWndProc: Some(procedure),
            hInstance: instance,
            lpszClassName: class.as_ptr(),
            ..std::mem::zeroed()
        };
        RegisterClassW(&wc);
        // An invisible top-level window receives power broadcasts; message-only windows do not.
        let hwnd = CreateWindowExW(
            0,
            class.as_ptr(),
            class.as_ptr(),
            0,
            0,
            0,
            0,
            0,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            instance,
            null(),
        );
        if !hwnd.is_null() {
            WTSRegisterSessionNotification(hwnd, 0);
        }
        let mut previous = false;
        loop {
            let active = ACTIVE.load(Ordering::SeqCst);
            if active != previous {
                SetThreadExecutionState(if active {
                    ES_CONTINUOUS | ES_SYSTEM_REQUIRED
                } else {
                    ES_CONTINUOUS
                });
                previous = active;
            }
            let mut msg: MSG = std::mem::zeroed();
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if APP.get().is_none() {
                break;
            }
            thread::sleep(Duration::from_millis(250));
        }
        SetThreadExecutionState(ES_CONTINUOUS);
        if !hwnd.is_null() {
            WTSUnRegisterSessionNotification(hwnd);
            DestroyWindow(hwnd);
        }
    }
}

#[cfg(target_os = "macos")]
unsafe fn mac_observers() {
    use objc::{
        class,
        declare::ClassDecl,
        msg_send,
        runtime::{Object, Sel},
        sel, sel_impl,
    };
    extern "C" fn resumed(_: &Object, _: Sel, _: *mut Object) {
        wake();
    }
    let mut declaration = ClassDecl::new("EnvGuardCCPowerObserver", class!(NSObject)).unwrap();
    declaration.add_method(
        sel!(resumed:),
        resumed as extern "C" fn(&Object, Sel, *mut Object),
    );
    let observer: *mut Object = msg_send![declaration.register(), new];
    let workspace: *mut Object = msg_send![class!(NSWorkspace), sharedWorkspace];
    let center: *mut Object = msg_send![workspace, notificationCenter];
    for name in [
        "NSWorkspaceDidWakeNotification\0",
        "NSWorkspaceSessionDidBecomeActiveNotification\0",
    ] {
        let name: *mut Object = msg_send![class!(NSString), stringWithUTF8String: name.as_ptr()];
        let _: () = msg_send![center, addObserver: observer selector: sel!(resumed:) name: name object: std::ptr::null_mut::<Object>()];
    }
    // Ordinary screen unlock does not always activate a different workspace session.
    let distributed: *mut Object =
        msg_send![class!(NSDistributedNotificationCenter), defaultCenter];
    let unlock: *mut Object =
        msg_send![class!(NSString), stringWithUTF8String: b"com.apple.screenIsUnlocked\0".as_ptr()];
    let _: () = msg_send![distributed, addObserver: observer selector: sel!(resumed:) name: unlock object: std::ptr::null_mut::<Object>()];
}

#[cfg(target_os = "macos")]
fn platform_loop() {
    use core_foundation::{
        base::TCFType,
        string::{CFString, CFStringRef},
    };
    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            kind: CFStringRef,
            level: u32,
            name: CFStringRef,
            id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }
    let mut assertion = None;
    loop {
        let active = ACTIVE.load(Ordering::SeqCst);
        if active && assertion.is_none() {
            let kind = CFString::new("PreventUserIdleSystemSleep");
            let name = CFString::new("EnvGuardCC protection");
            let mut id = 0;
            if unsafe {
                IOPMAssertionCreateWithName(
                    kind.as_concrete_TypeRef(),
                    1,
                    name.as_concrete_TypeRef(),
                    &mut id,
                )
            } == 0
            {
                assertion = Some(id);
            }
        } else if !active {
            if let Some(id) = assertion.take() {
                unsafe {
                    IOPMAssertionRelease(id);
                }
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(250));
    }
}

#[cfg(not(any(windows, target_os = "macos")))]
fn platform_loop() {}
