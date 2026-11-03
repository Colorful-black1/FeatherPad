use crate::models::{AppError, ErrorCode};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::Duration,
};
use tauri::{AppHandle, Manager};
use windows_sys::Win32::UI::{
    Input::KeyboardAndMouse::{
        RegisterHotKey, UnregisterHotKey, MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, VK_BACK,
        VK_DELETE, VK_DOWN, VK_END, VK_ESCAPE, VK_F1, VK_F10, VK_F11, VK_F12, VK_F2, VK_F3, VK_F4,
        VK_F5, VK_F6, VK_F7, VK_F8, VK_F9, VK_HOME, VK_LEFT, VK_NEXT, VK_OEM_2, VK_OEM_COMMA,
        VK_OEM_MINUS, VK_OEM_PERIOD, VK_OEM_PLUS, VK_PRIOR, VK_RETURN, VK_RIGHT, VK_SPACE, VK_TAB,
        VK_UP,
    },
    WindowsAndMessaging::{PeekMessageW, MSG, PM_REMOVE, WM_HOTKEY},
};

const HOTKEY_ID: i32 = 0x4650;
const POLL_INTERVAL: Duration = Duration::from_millis(20);

struct RunningShortcut {
    shortcut: String,
    stop: Arc<AtomicBool>,
    thread: JoinHandle<()>,
}

#[derive(Default)]
pub struct GlobalShortcutState(Mutex<Option<RunningShortcut>>);

#[derive(Clone, Debug, PartialEq, Eq)]
struct ParsedShortcut {
    modifiers: u32,
    virtual_key: u16,
}

fn parse_shortcut(shortcut: &str) -> Result<ParsedShortcut, AppError> {
    if shortcut.len() > 64 || shortcut.trim() != shortcut {
        return Err(invalid_shortcut());
    }
    let mut parts = shortcut.split('+').collect::<Vec<_>>();
    let key = parts.pop().ok_or_else(invalid_shortcut)?;
    let mut modifiers = 0u32;
    for modifier in parts {
        let flag = match modifier {
            "Ctrl" => MOD_CONTROL,
            "Shift" => MOD_SHIFT,
            "Alt" => MOD_ALT,
            _ => return Err(invalid_shortcut()),
        };
        if modifiers & flag != 0 {
            return Err(invalid_shortcut());
        }
        modifiers |= flag;
    }
    if modifiers & (MOD_CONTROL | MOD_ALT) == 0
        && !matches!(
            key,
            "F1" | "F2" | "F3" | "F4" | "F5" | "F6" | "F7" | "F8" | "F9" | "F10" | "F11" | "F12"
        )
    {
        return Err(invalid_shortcut());
    }
    if modifiers & MOD_CONTROL != 0 && modifiers & MOD_ALT != 0 {
        return Err(invalid_shortcut());
    }
    let virtual_key = match key {
        "Tab" => VK_TAB,
        "Escape" => VK_ESCAPE,
        "Space" => VK_SPACE,
        "ArrowUp" => VK_UP,
        "ArrowDown" => VK_DOWN,
        "ArrowLeft" => VK_LEFT,
        "ArrowRight" => VK_RIGHT,
        "Home" => VK_HOME,
        "End" => VK_END,
        "PageUp" => VK_PRIOR,
        "PageDown" => VK_NEXT,
        "Backspace" => VK_BACK,
        "Delete" => VK_DELETE,
        "Enter" => VK_RETURN,
        "," => VK_OEM_COMMA,
        "=" | "+" => VK_OEM_PLUS,
        "-" => VK_OEM_MINUS,
        "/" => VK_OEM_2,
        "." => VK_OEM_PERIOD,
        "F1" => VK_F1,
        "F2" => VK_F2,
        "F3" => VK_F3,
        "F4" => VK_F4,
        "F5" => VK_F5,
        "F6" => VK_F6,
        "F7" => VK_F7,
        "F8" => VK_F8,
        "F9" => VK_F9,
        "F10" => VK_F10,
        "F11" => VK_F11,
        "F12" => VK_F12,
        value if value.len() == 1 && value.as_bytes()[0].is_ascii_alphanumeric() => {
            value.as_bytes()[0].to_ascii_uppercase() as u16
        }
        _ => return Err(invalid_shortcut()),
    };
    Ok(ParsedShortcut {
        modifiers: modifiers | MOD_NOREPEAT,
        virtual_key,
    })
}

impl GlobalShortcutState {
    pub fn configure(
        &self,
        app: AppHandle,
        enabled: bool,
        shortcut: &str,
    ) -> Result<bool, AppError> {
        let mut running = self
            .0
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Internal, "全局快捷键状态不可用。"))?;
        if !enabled {
            stop(&mut running);
            return Ok(false);
        }
        if running
            .as_ref()
            .is_some_and(|item| item.shortcut == shortcut)
        {
            return Ok(true);
        }
        stop(&mut running);
        let parsed = parse_shortcut(shortcut)?;
        let stop_flag = Arc::new(AtomicBool::new(false));
        let worker_stop = stop_flag.clone();
        let worker_shortcut = shortcut.to_owned();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let mut message = unsafe { std::mem::zeroed::<MSG>() };
            unsafe {
                PeekMessageW(
                    &mut message,
                    std::ptr::null_mut(),
                    0,
                    0,
                    windows_sys::Win32::UI::WindowsAndMessaging::PM_NOREMOVE,
                )
            };
            let registered = unsafe {
                RegisterHotKey(
                    std::ptr::null_mut(),
                    HOTKEY_ID,
                    parsed.modifiers,
                    parsed.virtual_key as u32,
                )
            };
            if registered == 0 {
                let _ = ready_tx.send(Err("全局快捷键已被其他应用占用或系统拒绝注册。"));
                return;
            }
            let _ = ready_tx.send(Ok(()));
            while !worker_stop.load(Ordering::Acquire) {
                let available =
                    unsafe { PeekMessageW(&mut message, std::ptr::null_mut(), 0, 0, PM_REMOVE) };
                if available != 0 && message.message == WM_HOTKEY {
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.show();
                        let _ = window.unminimize();
                        let _ = window.set_focus();
                    }
                }
                thread::sleep(POLL_INTERVAL);
            }
            unsafe { UnregisterHotKey(std::ptr::null_mut(), HOTKEY_ID) };
        });
        match ready_rx.recv() {
            Ok(Ok(())) => {
                *running = Some(RunningShortcut {
                    shortcut: worker_shortcut,
                    stop: stop_flag,
                    thread: worker,
                });
                Ok(true)
            }
            Ok(Err(reason)) => {
                let _ = worker.join();
                Err(AppError::new(ErrorCode::Conflict, reason))
            }
            Err(_) => {
                let _ = worker.join();
                Err(AppError::new(
                    ErrorCode::IpcUnavailable,
                    "全局快捷键注册线程未能启动。",
                ))
            }
        }
    }
}

fn stop(running: &mut Option<RunningShortcut>) {
    if let Some(item) = running.take() {
        item.stop.store(true, Ordering::Release);
        let _ = item.thread.join();
    }
}

fn invalid_shortcut() -> AppError {
    AppError::new(ErrorCode::InvalidInput, "全局快捷键格式无效。")
}

#[cfg(test)]
mod tests {
    use super::parse_shortcut;
    use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
        MOD_ALT, MOD_CONTROL, MOD_NOREPEAT, MOD_SHIFT, VK_F9, VK_S,
    };

    #[test]
    fn parses_canonical_shortcuts_and_rejects_unsafe_or_ambiguous_values() {
        assert_eq!(
            parse_shortcut("Ctrl+Shift+F9").expect("valid shortcut"),
            super::ParsedShortcut {
                modifiers: MOD_CONTROL | MOD_SHIFT | MOD_NOREPEAT,
                virtual_key: VK_F9,
            }
        );
        assert_eq!(
            parse_shortcut("Alt+S").expect("valid shortcut"),
            super::ParsedShortcut {
                modifiers: MOD_ALT | MOD_NOREPEAT,
                virtual_key: VK_S,
            }
        );
        for value in [
            "",
            "S",
            "Shift+S",
            "Ctrl+Ctrl+S",
            "Meta+S",
            "Ctrl++S",
            "Ctrl+Alt+S",
            " Ctrl+S",
        ] {
            assert!(parse_shortcut(value).is_err(), "{value}");
        }
    }
}
