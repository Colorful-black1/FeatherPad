use crate::models::{AppError, ErrorCode};

pub fn validate_external_url(input: &str, confirmed: bool) -> Result<String, AppError> {
    if !confirmed {
        return Err(AppError::new(ErrorCode::Cancelled, "未确认打开外部链接。"));
    }
    if input.len() > 32_767
        || input.chars().any(char::is_control)
        || input.contains(['"', '\\', '<', '>'])
    {
        return Err(AppError::new(ErrorCode::InvalidInput, "外部链接格式无效。"));
    }
    let url = url::Url::parse(input)
        .map_err(|_| AppError::new(ErrorCode::InvalidInput, "外部链接格式无效。"))?;
    if !["http", "https", "mailto"].contains(&url.scheme())
        || !url.username().is_empty()
        || url.password().is_some()
        || (url.scheme() == "mailto") == url.has_host()
    {
        return Err(AppError::new(
            ErrorCode::OutOfScope,
            "只允许明确确认后的HTTP、HTTPS或mailto链接。",
        ));
    }
    Ok(url.to_string())
}

pub fn open_external_url(input: &str, confirmed: bool) -> Result<bool, AppError> {
    let url = validate_external_url(input, confirmed)?;
    #[cfg(windows)]
    {
        use windows::{
            core::{w, HSTRING, PCWSTR},
            Win32::{
                System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
                UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
            },
        };
        // Invoke the registered URI handler directly; there is no shell command
        // construction, no supplied program and no parameter string.
        let initialized = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
        let opened = unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                &HSTRING::from(url),
                PCWSTR::null(),
                PCWSTR::null(),
                SW_SHOWNORMAL,
            )
        };
        if initialized {
            unsafe {
                CoUninitialize();
            }
        }
        if opened.0 as isize > 32 {
            Ok(true)
        } else {
            Err(AppError::new(
                ErrorCode::Unsupported,
                "系统无法打开此链接，请检查默认浏览器或邮件应用。",
            ))
        }
    }
    #[cfg(not(windows))]
    {
        let _ = url;
        Err(AppError::new(
            ErrorCode::Unsupported,
            "当前仅支持Windows链接打开。",
        ))
    }
}
