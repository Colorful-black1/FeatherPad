pub mod associations;
pub mod webview2;

/// 用 Tauri 已解码的窗口图标，通过 Win32 生成 HICON，并用 WM_SETICON 同时设置大/小图标。
///
/// 任务栏使用 ICON_BIG（32px）；Tauri 自带的 set_icon 在自定义标题栏下只落地了小图标，
/// 任务栏取不到大图标时会回落到默认的空白文档图标。
pub fn apply_window_icon(window: &tauri::WebviewWindow, icon: &tauri::image::Image<'_>) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{SendMessageW, WM_SETICON};

    const ICON_SMALL: usize = 0;
    const ICON_BIG: usize = 1;

    let Ok(hwnd) = window.hwnd() else {
        return;
    };
    // tauri 的 hwnd() 返回 `windows` crate 的 HWND newtype，取内部裸指针交给 windows-sys
    let hwnd = hwnd.0 as windows_sys::Win32::Foundation::HWND;

    let width = icon.width() as usize;
    let height = icon.height() as usize;
    let rgba = icon.rgba();
    if width == 0 || height == 0 || rgba.len() < width * height * 4 {
        return;
    }

    if let Some(big) = create_hicon(rgba, width, height) {
        unsafe { SendMessageW(hwnd, WM_SETICON, ICON_BIG, big as isize) };
    }
    if let Some(small) = create_hicon(rgba, width, height) {
        unsafe { SendMessageW(hwnd, WM_SETICON, ICON_SMALL, small as isize) };
    }
}

/// 从 RGBA 像素构造 32 位带 alpha 的 HICON。
fn create_hicon(rgba: &[u8], width: usize, height: usize) -> Option<*mut core::ffi::c_void> {
    use windows_sys::Win32::Graphics::Gdi::{
        CreateBitmap, CreateDIBSection, DeleteObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB,
        DIB_RGB_COLORS,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{CreateIconIndirect, ICONINFO};

    unsafe {
        // 32bpp 顶朝下 DIB：CreateDIBSection 用负高度表示自上而下
        let mut header: BITMAPINFOHEADER = core::mem::zeroed();
        header.biSize = core::mem::size_of::<BITMAPINFOHEADER>() as u32;
        header.biWidth = width as i32;
        header.biHeight = -(height as i32);
        header.biPlanes = 1;
        header.biBitCount = 32;
        header.biCompression = BI_RGB as u32;
        let mut info: BITMAPINFO = core::mem::zeroed();
        info.bmiHeader = header;

        let mut bits: *mut core::ffi::c_void = std::ptr::null_mut();
        let color = CreateDIBSection(
            std::ptr::null_mut(),
            &info,
            DIB_RGB_COLORS,
            &mut bits,
            std::ptr::null_mut(),
            0,
        );
        if color.is_null() || bits.is_null() {
            return None;
        }

        // 源是 RGBA，目标是 BGRA（DIB 的字节序）
        let dst = std::slice::from_raw_parts_mut(bits as *mut u8, width * height * 4);
        for i in 0..width * height {
            let s = &rgba[i * 4..i * 4 + 4];
            if s[3] == 0 {
                // 全透明像素置零，避免黑色杂边
                dst[i * 4..i * 4 + 4].fill(0);
            } else {
                dst[i * 4] = s[2];
                dst[i * 4 + 1] = s[1];
                dst[i * 4 + 2] = s[0];
                dst[i * 4 + 3] = s[3];
            }
        }

        // AND 掩码：全 0（完全由 alpha 通道决定）
        let mask = CreateBitmap(width as i32, height as i32, 1, 1, std::ptr::null());
        if mask.is_null() {
            DeleteObject(color as _);
            return None;
        }

        let mut icon_info: ICONINFO = core::mem::zeroed();
        icon_info.fIcon = 1;
        icon_info.hbmColor = color;
        icon_info.hbmMask = mask;
        let hicon = CreateIconIndirect(&icon_info);

        // CreateIconIndirect 会复制位图，原始对象可以释放
        DeleteObject(color as _);
        DeleteObject(mask as _);

        if hicon.is_null() {
            None
        } else {
            Some(hicon as *mut core::ffi::c_void)
        }
    }
}

pub fn show_error(message: &str) {
    use windows_sys::Win32::UI::WindowsAndMessaging::{MessageBoxW, MB_ICONERROR, MB_OK};

    let title = "轻羽 FeatherPad"
        .encode_utf16()
        .chain(Some(0))
        .collect::<Vec<_>>();
    let text = message.encode_utf16().chain(Some(0)).collect::<Vec<_>>();
    unsafe {
        MessageBoxW(
            std::ptr::null_mut(),
            text.as_ptr(),
            title.as_ptr(),
            MB_OK | MB_ICONERROR,
        );
    }
}
