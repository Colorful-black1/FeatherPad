use crate::models::{AppError, ErrorCode};
use serde::Serialize;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalFonts {
    pub families: Vec<String>,
    pub truncated: bool,
}

#[cfg(windows)]
pub fn list_font_families() -> Result<LocalFonts, AppError> {
    use std::collections::BTreeSet;
    use windows_sys::Win32::{
        Foundation::LPARAM,
        Graphics::Gdi::{
            EnumFontFamiliesExW, GetDC, ReleaseDC, DEFAULT_CHARSET, LOGFONTW, TEXTMETRICW,
        },
    };
    struct Collector {
        names: BTreeSet<String>,
        truncated: bool,
    }
    unsafe extern "system" fn collect(
        font: *const LOGFONTW,
        _: *const TEXTMETRICW,
        _: u32,
        state: LPARAM,
    ) -> i32 {
        // SAFETY: EnumFontFamiliesExW calls synchronously with a valid LOGFONTW and
        // the live Collector pointer supplied below. Neither pointer escapes this callback.
        let (font, state) = unsafe { (&*font, &mut *(state as *mut Collector)) };
        let length = font
            .lfFaceName
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(font.lfFaceName.len());
        if let Ok(name) = String::from_utf16(&font.lfFaceName[..length]) {
            if !name.is_empty() && !name.starts_with('@') {
                state.names.insert(name);
            }
        }
        if state.names.len() >= 4096 {
            state.truncated = true;
            return 0;
        }
        1
    }
    // SAFETY: GetDC(NULL) requests a screen DC; no window ownership is transferred.
    let dc = unsafe { GetDC(std::ptr::null_mut()) };
    if dc.is_null() {
        return Err(AppError::new(
            ErrorCode::Internal,
            "无法读取本机字体列表，将使用本地后备字体。",
        ));
    }
    let mut collector = Collector {
        names: BTreeSet::new(),
        truncated: false,
    };
    // SAFETY: zero is valid for all unused LOGFONTW fields; DEFAULT_CHARSET enumerates all families.
    let font = LOGFONTW {
        lfCharSet: DEFAULT_CHARSET,
        ..unsafe { std::mem::zeroed() }
    };
    // SAFETY: live DC/LOGFONTW/Collector; the API does not retain the callback or pointers.
    unsafe {
        EnumFontFamiliesExW(
            dc,
            &font,
            Some(collect),
            &mut collector as *mut Collector as LPARAM,
            0,
        );
        ReleaseDC(std::ptr::null_mut(), dc);
    }
    if collector.names.is_empty() {
        return Err(AppError::new(
            ErrorCode::Internal,
            "本机字体列表为空，将使用本地后备字体。",
        ));
    }
    Ok(LocalFonts {
        families: collector.names.into_iter().collect(),
        truncated: collector.truncated,
    })
}

#[cfg(not(windows))]
pub fn list_font_families() -> Result<LocalFonts, AppError> {
    Err(AppError::new(
        ErrorCode::Unsupported,
        "当前平台尚不支持本机字体枚举。",
    ))
}
