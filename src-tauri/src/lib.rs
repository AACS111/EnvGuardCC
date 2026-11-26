#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod desktop;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod login;
#[cfg(not(any(target_os = "android", target_os = "ios")))]
mod power;

pub mod mobile_common;

#[cfg(any(target_os = "android", target_os = "ios"))]
mod mobile;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    desktop::run();

    #[cfg(any(target_os = "android", target_os = "ios"))]
    mobile::run();
}
