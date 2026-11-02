use super::grants::GrantRegistry;
use crate::models::{AppError, ErrorCode, FileRef};
use serde::Serialize;
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc,
    },
};

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEntry {
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub kind: &'static str,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEvent {
    pub watch_id: String,
    pub sequence: u64,
    pub entries: Vec<WatchEntry>,
    pub overflow: bool,
}

#[derive(Default)]
pub struct WatchRegistry {
    active: HashMap<String, Arc<AtomicBool>>,
}

impl Drop for WatchRegistry {
    fn drop(&mut self) {
        for stopped in self.active.values() {
            stopped.store(true, Ordering::Release);
        }
    }
}

impl WatchRegistry {
    pub fn start(
        &mut self,
        grants: &GrantRegistry,
        refs: Vec<FileRef>,
        emit: Arc<dyn Fn(WatchEvent) + Send + Sync>,
    ) -> Result<String, AppError> {
        if refs.is_empty() || refs.len() > 256 || self.active.len() >= 4 {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "监听最多接受256个文件引用和4个订阅。",
            ));
        }
        let mut parents = HashMap::<std::path::PathBuf, Vec<FileRef>>::new();
        for reference in refs {
            let (_, path) = grants.open_file(&reference)?;
            let parent = path
                .parent()
                .ok_or_else(|| AppError::new(ErrorCode::InvalidInput, "文件父目录无效。"))?;
            let entries = parents.entry(parent.to_owned()).or_default();
            if !entries.contains(&reference) {
                entries.push(reference);
            }
        }
        if parents.len() > 64 {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "一个监听订阅最多涉及64个目录。",
            ));
        }
        let id = uuid::Uuid::new_v4().to_string();
        let stopped = Arc::new(AtomicBool::new(false));
        let sequence = Arc::new(AtomicU64::new(0));
        // Open all directories before spawning; partial failure grants no live subscription.
        let directories = parents
            .into_iter()
            .map(|(path, refs)| native::open(&path).map(|directory| (directory, refs)))
            .collect::<Result<Vec<_>, _>>()?;
        for (directory, refs) in directories {
            let worker_stopped = stopped.clone();
            let sequence = sequence.clone();
            let emit = emit.clone();
            let watch_id = id.clone();
            let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
            let spawned = std::thread::Builder::new()
                .name("featherpad-watch".into())
                .spawn(move || {
                    native::run(
                        directory,
                        worker_stopped,
                        move |overflow| {
                            emit(WatchEvent {
                                watch_id: watch_id.clone(),
                                sequence: sequence.fetch_add(1, Ordering::Relaxed) + 1,
                                // Windows names never cross IPC. Every selected file in the changed
                                // parent is invalidated, and consumers stat the current authorized path.
                                entries: refs
                                    .iter()
                                    .cloned()
                                    .map(|reference| WatchEntry {
                                        reference,
                                        kind: "changed",
                                    })
                                    .collect(),
                                overflow,
                            });
                        },
                        ready_tx,
                    );
                });
            if spawned.is_err()
                || !matches!(
                    ready_rx.recv_timeout(std::time::Duration::from_secs(2)),
                    Ok(Ok(()))
                )
            {
                stopped_cancel(&stopped);
                return Err(AppError::new(
                    ErrorCode::Internal,
                    "无法开始文件监听，请使用重新核对或聚焦窗口。",
                ));
            }
        }
        self.active.insert(id.clone(), stopped);
        Ok(id)
    }

    pub fn stop(&mut self, id: &str) -> bool {
        if let Some(stopped) = self.active.remove(id) {
            stopped.store(true, Ordering::Release);
            true
        } else {
            false
        }
    }
}

fn stopped_cancel(stopped: &AtomicBool) {
    stopped.store(true, Ordering::Release);
}

#[cfg(windows)]
mod native {
    use super::*;
    use crate::{models::io_error, services::grants::opened_file_path};
    use std::{
        fs::{File, OpenOptions},
        os::windows::{
            fs::OpenOptionsExt,
            io::{AsRawHandle, FromRawHandle, OwnedHandle},
        },
        path::Path,
    };
    use windows_sys::Win32::{
        Foundation::{WAIT_OBJECT_0, WAIT_TIMEOUT},
        Storage::FileSystem::{
            ReadDirectoryChangesW, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OVERLAPPED,
            FILE_LIST_DIRECTORY, FILE_NOTIFY_CHANGE_ATTRIBUTES, FILE_NOTIFY_CHANGE_DIR_NAME,
            FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE,
            FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        },
        System::{
            Threading::{CreateEventW, WaitForSingleObject},
            IO::{CancelIoEx, GetOverlappedResult, OVERLAPPED},
        },
    };

    pub fn open(path: &Path) -> Result<File, AppError> {
        let file = OpenOptions::new()
            .access_mode(FILE_LIST_DIRECTORY)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED)
            .open(path)
            .map_err(io_error)?;
        if !file.metadata().map_err(io_error)?.is_dir() || opened_file_path(&file)? != path {
            return Err(AppError::new(
                ErrorCode::OutOfScope,
                "监听目录已变化，请重新选择文件。",
            ));
        }
        Ok(file)
    }

    pub fn run(
        directory: File,
        stopped: Arc<AtomicBool>,
        emit: impl Fn(bool),
        ready: std::sync::mpsc::SyncSender<Result<(), ()>>,
    ) {
        // SAFETY: unnamed manual-reset event; default security, no borrowed pointers retained.
        let event = unsafe { CreateEventW(std::ptr::null(), 1, 0, std::ptr::null()) };
        if event.is_null() {
            let _ = ready.send(Err(()));
            return;
        }
        // SAFETY: successful CreateEventW transfers ownership of a new handle.
        let event = unsafe { OwnedHandle::from_raw_handle(event) };
        let mut ready = Some(ready);
        // u32 storage supplies DWORD alignment. The buffer and OVERLAPPED stay alive until
        // completion (including cancellation), and are never read while the OS writes them.
        let mut buffer = vec![0u32; 16 * 1024];
        loop {
            if stopped.load(Ordering::Acquire) {
                return;
            }
            let mut operation = OVERLAPPED {
                hEvent: event.as_raw_handle(),
                ..unsafe { std::mem::zeroed() }
            };
            // SAFETY: live directory/event and stable, uniquely borrowed buffer/OVERLAPPED.
            let armed = unsafe {
                ReadDirectoryChangesW(
                    directory.as_raw_handle(),
                    buffer.as_mut_ptr().cast(),
                    (buffer.len() * 4) as u32,
                    0,
                    FILE_NOTIFY_CHANGE_FILE_NAME
                        | FILE_NOTIFY_CHANGE_DIR_NAME
                        | FILE_NOTIFY_CHANGE_LAST_WRITE
                        | FILE_NOTIFY_CHANGE_SIZE
                        | FILE_NOTIFY_CHANGE_ATTRIBUTES,
                    std::ptr::null_mut(),
                    &mut operation,
                    None,
                )
            };
            if armed == 0 {
                if let Some(ready) = ready.take() {
                    let _ = ready.send(Err(()));
                } else {
                    emit(true);
                }
                return;
            }
            if let Some(ready) = ready.take() {
                let _ = ready.send(Ok(()));
            }
            let wait = loop {
                // SAFETY: event belongs to this thread and remains live through the wait.
                let wait = unsafe { WaitForSingleObject(event.as_raw_handle(), 250) };
                if wait != WAIT_TIMEOUT || stopped.load(Ordering::Acquire) {
                    break wait;
                }
            };
            let mut bytes = 0;
            if stopped.load(Ordering::Acquire) || wait != WAIT_OBJECT_0 {
                // SAFETY: cancel only this operation; wait for completion before dropping memory.
                unsafe {
                    CancelIoEx(directory.as_raw_handle(), &operation);
                    GetOverlappedResult(directory.as_raw_handle(), &operation, &mut bytes, 1);
                }
                if !stopped.load(Ordering::Acquire) {
                    emit(true);
                }
                return;
            }
            // SAFETY: event signaled; completion transfers buffer ownership back to us.
            let complete = unsafe {
                GetOverlappedResult(directory.as_raw_handle(), &operation, &mut bytes, 0)
            };
            if !stopped.load(Ordering::Acquire) {
                emit(complete == 0 || bytes == 0);
            }
            if complete == 0 {
                return;
            }
        }
    }
}

#[cfg(not(windows))]
mod native {
    use super::*;
    pub fn open(_: &std::path::Path) -> Result<std::fs::File, AppError> {
        Err(AppError::new(
            ErrorCode::Unsupported,
            "当前平台尚不支持文件监听。",
        ))
    }
    pub fn run(
        _: std::fs::File,
        _: Arc<AtomicBool>,
        _: impl Fn(bool),
        ready: std::sync::mpsc::SyncSender<Result<(), ()>>,
    ) {
        let _ = ready.send(Err(()));
    }
}
