use crate::models::{AppError, ErrorCode};
use std::{
    cell::RefCell,
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager};
use webview2_com::{Microsoft::Web::WebView2::Win32::*, PrintToPdfStreamCompletedHandler};
use windows::{
    core::{Interface, PCWSTR},
    Win32::System::Com::{IStream, STATFLAG_NONAME, STATSTG, STREAM_SEEK_SET},
};
use wry::{WebView, WebViewBuilder, WebViewBuilderExtWindows, WebViewExtWindows};

#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PdfOptions {
    pub paper: String,
    pub landscape: bool,
    pub margins_mm: Margins,
}
#[derive(Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Margins {
    pub top: f64,
    pub right: f64,
    pub bottom: f64,
    pub left: f64,
}
impl PdfOptions {
    pub fn validate(&self) -> Result<(), AppError> {
        if !["a4", "letter"].contains(&self.paper.as_str())
            || [
                self.margins_mm.top,
                self.margins_mm.right,
                self.margins_mm.bottom,
                self.margins_mm.left,
            ]
            .iter()
            .any(|value| !value.is_finite() || !(0.0..=50.0).contains(value))
        {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "纸张或页边距无效，页边距需为0–50mm。",
            ));
        }
        Ok(())
    }
}

struct Job {
    view: WebView,
    options: PdfOptions,
    loaded: Arc<AtomicBool>,
    checking: bool,
    printing: bool,
    sender: Option<mpsc::Sender<Result<Vec<u8>, AppError>>>,
}
thread_local! { static JOBS:RefCell<HashMap<String,Job>> = RefCell::new(HashMap::new()); }

pub fn render(
    app: &AppHandle,
    id: &str,
    html: String,
    options: PdfOptions,
    cancelled: &AtomicBool,
) -> Result<Vec<u8>, AppError> {
    options.validate()?;
    let (sender, receiver) = mpsc::channel();
    let window = app.get_webview_window("main").ok_or_else(backend)?;
    let parent = window.clone();
    let key = id.to_owned();
    let error_sender = sender.clone();
    window
        .with_webview(move |platform| {
            if let Err(error) = create(&parent, platform.environment(), key, html, options, sender)
            {
                let _ = error_sender.send(Err(error));
            }
        })
        .map_err(|_| backend())?;
    let start = Instant::now();
    let result = loop {
        if cancelled.load(Ordering::Acquire) {
            break Err(AppError::new(
                ErrorCode::Cancelled,
                "已取消PDF生成，未写入目标文件。",
            ));
        }
        if start.elapsed() > Duration::from_secs(60) {
            break Err(AppError::new(
                ErrorCode::Internal,
                "PDF生成超过60秒，已停止；目标文件保留。",
            ));
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(result) => break result,
            Err(mpsc::RecvTimeoutError::Disconnected) => break Err(backend()),
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let key = id.to_owned();
                if app.run_on_main_thread(move || poll(&key)).is_err() {
                    break Err(backend());
                }
            }
        }
    };
    let key = id.to_owned();
    let _ = app.run_on_main_thread(move || {
        JOBS.with(|jobs| {
            jobs.borrow_mut().remove(&key);
        });
    });
    result.and_then(|bytes| {
        validate_pdf(&bytes)?;
        Ok(bytes)
    })
}

fn create(
    parent: &tauri::WebviewWindow,
    environment: ICoreWebView2Environment,
    key: String,
    html: String,
    options: PdfOptions,
    sender: mpsc::Sender<Result<Vec<u8>, AppError>>,
) -> Result<(), AppError> {
    let loaded = Arc::new(AtomicBool::new(false));
    let page_loaded = loaded.clone();
    let request_path = format!("/{key}");
    let expected_path = request_path.clone();
    let body: Arc<[u8]> = html.into_bytes().into();
    // The view is raw Wry: no Tauri bootstrap, IPC, host objects, or document
    // initialization scripts. Configure all native boundaries before navigation.
    let view=WebViewBuilder::new().with_environment(environment.clone()).with_visible(false).with_focused(false)
        .with_bounds(wry::Rect{position:tauri::LogicalPosition::new(0.0,0.0).into(),size:tauri::LogicalSize::new(1000.0,800.0).into()})
        .with_navigation_handler(move|url| url==format!("http://featherpad-export.localhost{request_path}"))
        .with_new_window_req_handler(|_,_|wry::NewWindowResponse::Deny)
        .with_on_page_load_handler(move|event,_|{if matches!(event,wry::PageLoadEvent::Finished) {page_loaded.store(true,Ordering::Release);}})
        .with_custom_protocol("featherpad-export".into(),move|_,request|{
            let allowed=request.uri().path()==expected_path && request.method()=="GET";
            wry::http::Response::builder().status(if allowed{200}else{403})
                .header("Content-Type","text/html; charset=utf-8")
                .header("Content-Security-Policy","default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")
                .body(if allowed{std::borrow::Cow::Owned(body.to_vec())}else{std::borrow::Cow::Borrowed(&b""[..])}).expect("static export response")
        }).build_as_child(parent).map_err(|_|backend())?;
    let webview = unsafe { view.controller().CoreWebView2() }.map_err(|_| backend())?;
    // SAFETY: all COM objects and event handlers live on the owning UI thread.
    unsafe {
        let settings = webview.Settings().map_err(|_| backend())?;
        settings.SetIsScriptEnabled(false).map_err(|_| backend())?;
        settings
            .SetIsWebMessageEnabled(false)
            .map_err(|_| backend())?;
        settings
            .SetAreHostObjectsAllowed(false)
            .map_err(|_| backend())?;
        settings
            .SetAreDevToolsEnabled(false)
            .map_err(|_| backend())?;
        settings
            .SetAreDefaultScriptDialogsEnabled(false)
            .map_err(|_| backend())?;
        webview
            .AddWebResourceRequestedFilter(
                PCWSTR::from_raw(windows::core::w!("*").as_ptr()),
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            )
            .map_err(|_| backend())?;
        let env = environment.clone();
        let allowed_page = format!("http://featherpad-export.localhost/{key}");
        let mut token = 0;
        webview
            .add_WebResourceRequested(
                &webview2_com::WebResourceRequestedEventHandler::create(Box::new(
                    move |_, args| {
                        if let Some(args) = args {
                            let request = args.Request()?;
                            let mut uri = windows::core::PWSTR::null();
                            request.Uri(&mut uri)?;
                            let url = uri.to_string()?;
                            windows::Win32::System::Com::CoTaskMemFree(Some(uri.0.cast()));
                            // Never fetch external/file URLs even if an IPC caller supplied
                            // malformed HTML that bypassed the renderer's whitelist.
                            if url != allowed_page && !url.starts_with("data:image/") {
                                let response = env.CreateWebResourceResponse(
                                    None,
                                    403,
                                    windows::core::w!("Blocked"),
                                    windows::core::w!("Content-Type: text/plain"),
                                )?;
                                args.SetResponse(&response)?;
                            }
                        }
                        Ok(())
                    },
                )),
                &mut token,
            )
            .map_err(|_| backend())?;
    }
    let url = format!("http://featherpad-export.localhost/{key}");
    JOBS.with(|jobs| {
        jobs.borrow_mut().insert(
            key.clone(),
            Job {
                view,
                options,
                loaded,
                checking: false,
                printing: false,
                sender: Some(sender),
            },
        );
    });
    JOBS.with(|jobs| jobs.borrow().get(&key).unwrap().view.load_url(&url))
        .map_err(|_| backend())
}

fn poll(key: &str) {
    let result=JOBS.with(|jobs|{
        let mut jobs=jobs.borrow_mut(); let Some(job)=jobs.get_mut(key)else{return Ok(());};
        if job.printing || job.checking || !job.loaded.load(Ordering::Acquire) {return Ok(());}
        job.checking=true; let id=key.to_owned();
        // This constant host probe is the only evaluated script. Document
        // scripts remain disabled, including in subframes.
        job.view.evaluate_script_with_callback("document.readyState==='complete' && document.fonts.status==='loaded' && [...document.images].every(i=>i.complete && i.naturalWidth>0)",move|result|{
            JOBS.with(|jobs|{if let Some(job)=jobs.borrow_mut().get_mut(&id){job.checking=false;}});
            if result=="true" {if let Err(error)=print(&id){complete(&id,Err(error));}}
        }).map_err(|_|backend())
    });
    if let Err(error) = result {
        complete(key, Err(error));
    }
}

fn print(key: &str) -> Result<(), AppError> {
    JOBS.with(|jobs| {
        let mut jobs = jobs.borrow_mut();
        let Some(job) = jobs.get_mut(key) else {
            return Ok(());
        };
        if job.printing {
            return Ok(());
        }
        job.printing = true;
        // SAFETY: called on the owning UI thread, validated finite print values.
        unsafe {
            let environment = job
                .view
                .environment()
                .cast::<ICoreWebView2Environment6>()
                .map_err(|_| backend())?;
            let settings = environment.CreatePrintSettings().map_err(|_| backend())?;
            let (width, height) = if job.options.paper == "a4" {
                (210.0 / 25.4, 297.0 / 25.4)
            } else {
                (8.5, 11.0)
            };
            let m = &job.options.margins_mm;
            settings.SetPageWidth(width).map_err(|_| backend())?;
            settings.SetPageHeight(height).map_err(|_| backend())?;
            settings
                .SetOrientation(if job.options.landscape {
                    COREWEBVIEW2_PRINT_ORIENTATION_LANDSCAPE
                } else {
                    COREWEBVIEW2_PRINT_ORIENTATION_PORTRAIT
                })
                .map_err(|_| backend())?;
            settings.SetMarginTop(m.top / 25.4).map_err(|_| backend())?;
            settings
                .SetMarginRight(m.right / 25.4)
                .map_err(|_| backend())?;
            settings
                .SetMarginBottom(m.bottom / 25.4)
                .map_err(|_| backend())?;
            settings
                .SetMarginLeft(m.left / 25.4)
                .map_err(|_| backend())?;
            settings
                .SetShouldPrintBackgrounds(true)
                .map_err(|_| backend())?;
            settings
                .SetShouldPrintHeaderAndFooter(false)
                .map_err(|_| backend())?;
            let webview = job
                .view
                .controller()
                .CoreWebView2()
                .map_err(|_| backend())?
                .cast::<ICoreWebView2_16>()
                .map_err(|_| backend())?;
            let id = key.to_owned();
            webview
                .PrintToPdfStream(
                    &settings,
                    &PrintToPdfStreamCompletedHandler::create(Box::new(move |status, stream| {
                        let result = match (status, stream) {
                            (Ok(()), Some(stream)) => read_stream(&stream),
                            _ => Err(AppError::new(
                                ErrorCode::Internal,
                                "WebView2未能生成PDF，目标文件保留。",
                            )),
                        };
                        complete(&id, result);
                        Ok(())
                    })),
                )
                .map_err(|_| backend())?;
        }
        Ok(())
    })
}
fn complete(key: &str, result: Result<Vec<u8>, AppError>) {
    JOBS.with(|jobs| {
        if let Some(sender) = jobs
            .borrow_mut()
            .get_mut(key)
            .and_then(|job| job.sender.take())
        {
            let _ = sender.send(result);
        }
    });
}
fn read_stream(stream: &IStream) -> Result<Vec<u8>, AppError> {
    // SAFETY: callback-owned stream, bounded initialized output buffer.
    unsafe {
        let mut stat = STATSTG::default();
        stream
            .Stat(&mut stat, STATFLAG_NONAME)
            .map_err(|_| backend())?;
        if stat.cbSize == 0 || stat.cbSize > 100 * 1024 * 1024 {
            return Err(AppError::new(ErrorCode::TooLarge, "PDF为空或超过100MiB。"));
        }
        stream
            .Seek(0, STREAM_SEEK_SET, None)
            .map_err(|_| backend())?;
        let mut bytes = vec![0; stat.cbSize as usize];
        let mut read = 0;
        stream
            .Read(
                bytes.as_mut_ptr().cast(),
                bytes.len() as u32,
                Some(&mut read),
            )
            .ok()
            .map_err(|_| backend())?;
        if read as usize != bytes.len() {
            return Err(AppError::new(
                ErrorCode::Internal,
                "PDF流不完整，未写入目标。",
            ));
        }
        Ok(bytes)
    }
}
pub fn validate_pdf(bytes: &[u8]) -> Result<(), AppError> {
    let has_page = bytes.windows(11).enumerate().any(|(index, part)| {
        part == b"/Type /Page"
            && bytes
                .get(index + 11)
                .is_some_and(|next| !next.is_ascii_alphabetic())
    });
    if !bytes.starts_with(b"%PDF-")
        || !bytes[bytes.len().saturating_sub(1024)..]
            .windows(5)
            .any(|part| part == b"%%EOF")
        || !has_page
    {
        return Err(AppError::new(
            ErrorCode::Internal,
            "生成结果不是完整且含页面的PDF，未写入目标。",
        ));
    }
    Ok(())
}
fn backend() -> AppError {
    AppError::new(ErrorCode::Unsupported,"本机WebView2不支持安全PDF后端。请离线安装支持PrintToPdfStream的WebView2 Evergreen运行时后重试；未写入目标。")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_empty_or_zero_page_pdf() {
        assert!(validate_pdf(b"").is_err());
        assert!(validate_pdf(b"%PDF-1.7\n%%EOF").is_err());
        assert!(validate_pdf(b"%PDF-1.7\n/Type /Page\n%%EOF").is_ok());
    }
}
