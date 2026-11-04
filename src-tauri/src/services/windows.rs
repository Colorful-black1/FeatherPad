use super::{
    cli::{CliRun, GotoTarget},
    data_dir::coordination_root,
    grants::GrantKind,
};
use crate::models::{io_error, AppError, ErrorCode, FileRef};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    thread,
    time::{Duration, Instant},
};

const REQUEST_SCHEMA: u8 = 1;
const MAX_REQUEST_BYTES: u64 = 64 * 1024;
const MAX_PENDING_DELIVERIES: usize = 128;
const ACK_TIMEOUT: Duration = Duration::from_secs(30);
const OWNER_WAIT: Duration = Duration::from_secs(2);
const POLL_INTERVAL: Duration = Duration::from_millis(50);

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RoutedTarget {
    pub path: String,
    pub kind: RouteTargetKind,
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub display_name: String,
    pub goto: Option<GotoTarget>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RouteTargetKind {
    File,
    Directory,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DesktopDelivery {
    pub request_id: String,
    pub window_id: String,
    pub wait: bool,
    pub targets: Vec<RoutedTarget>,
    pub failures: Vec<String>,
}

#[derive(Debug, Eq, PartialEq)]
pub struct TargetResolution {
    pub targets: Vec<RoutedTarget>,
    pub failures: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct InboxRequest {
    pub(crate) schema_version: u8,
    pub(crate) request_id: String,
    pub(crate) cwd: String,
    pub(crate) run: CliRun,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RouteAck {
    ok: bool,
    partial: bool,
    message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CompleteAck {
    ok: bool,
    message: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OwnerRecord {
    pid: u32,
}

pub enum InstanceStart {
    Primary(InstanceGuard),
    Secondary(SecondaryOutcome),
}

pub struct InstanceGuard {
    root: PathBuf,
    #[cfg(windows)]
    handle: isize,
}

pub struct SecondaryOutcome {
    pub exit_code: u8,
    pub message: String,
}

pub struct DesktopCoordinator {
    guard: InstanceGuard,
    pending: Mutex<VecDeque<DesktopDelivery>>,
    active: Mutex<HashMap<String, String>>,
    owners: Mutex<HashMap<String, String>>,
    session_guard: Mutex<()>,
}

impl InstanceGuard {
    pub fn root(&self) -> &Path {
        &self.root
    }
}

impl DesktopCoordinator {
    pub fn new(guard: InstanceGuard) -> Self {
        Self {
            guard,
            pending: Mutex::new(VecDeque::new()),
            active: Mutex::new(HashMap::new()),
            owners: Mutex::new(HashMap::new()),
            session_guard: Mutex::new(()),
        }
    }

    pub fn root(&self) -> &Path {
        self.guard.root()
    }

    pub fn enqueue_initial(&self, run: CliRun) -> Result<(), AppError> {
        if run.paths.is_empty() && run.goto.is_none() {
            return Ok(());
        }
        let request = inbox_request(run)?;
        write_json_once(
            &requests_dir(self.root()).join(format!("{}.json", request.request_id)),
            &request,
        )
    }

    pub fn enqueue(&self, delivery: DesktopDelivery) -> Result<(), AppError> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Internal, "窗口请求队列不可用"))?;
        if pending.len() >= MAX_PENDING_DELIVERIES {
            return Err(AppError::new(
                ErrorCode::Busy,
                "待处理窗口请求过多，请关闭一些窗口后重试",
            ));
        }
        pending.push_back(delivery);
        Ok(())
    }

    pub fn take(&self, window_id: &str) -> Result<Vec<DesktopDelivery>, AppError> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Internal, "窗口请求队列不可用"))?;
        let mut selected = Vec::new();
        let mut retained = VecDeque::with_capacity(pending.len());
        while let Some(delivery) = pending.pop_front() {
            if delivery.window_id == window_id {
                selected.push(delivery);
            } else {
                retained.push_back(delivery);
            }
        }
        *pending = retained;
        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Internal, "窗口请求状态不可用"))?;
        for delivery in &selected {
            active.insert(delivery.request_id.clone(), window_id.to_owned());
        }
        Ok(selected)
    }

    pub fn complete(&self, request_id: &str, window_id: &str) -> Result<(), AppError> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Internal, "窗口请求状态不可用"))?;
        match active.get(request_id) {
            Some(owner) if owner == window_id => {
                active.remove(request_id);
                Ok(())
            }
            Some(_) => Err(AppError::new(
                ErrorCode::PermissionDenied,
                "该 CLI 请求不属于当前窗口",
            )),
            None => Err(AppError::new(ErrorCode::NotFound, "CLI 请求已完成或已失效")),
        }
    }

    pub fn claim_document(&self, document_id: &str, window_id: &str) -> Result<String, AppError> {
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Internal, "文档窗口所有权不可用"))?;
        match owners.get(document_id) {
            Some(owner) => Ok(owner.clone()),
            None => {
                owners.insert(document_id.to_owned(), window_id.to_owned());
                Ok(window_id.to_owned())
            }
        }
    }

    pub fn owns_document(&self, document_id: &str, window_id: &str) -> Result<bool, AppError> {
        let owners = self
            .owners
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Internal, "文档窗口所有权不可用"))?;
        Ok(owners
            .get(document_id)
            .is_none_or(|owner| owner == window_id))
    }

    pub fn release_window(&self, window_id: &str) -> Result<Vec<String>, AppError> {
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Internal, "文档窗口所有权不可用"))?;
        let released = owners
            .iter()
            .filter(|(_, owner)| owner.as_str() == window_id)
            .map(|(document, _)| document.clone())
            .collect::<Vec<_>>();
        owners.retain(|_, owner| owner != window_id);
        Ok(released)
    }

    pub fn finish_window_requests(&self, window_id: &str) -> Result<Vec<String>, AppError> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Internal, "窗口请求状态不可用"))?;
        let finished = active
            .iter()
            .filter(|(_, owner)| owner.as_str() == window_id)
            .map(|(request_id, _)| request_id.clone())
            .collect::<Vec<_>>();
        active.retain(|_, owner| owner != window_id);
        Ok(finished)
    }

    pub fn release_document(&self, document_id: &str, window_id: &str) -> Result<(), AppError> {
        let mut owners = self
            .owners
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Internal, "文档窗口所有权不可用"))?;
        if owners
            .get(document_id)
            .is_none_or(|owner| owner == window_id)
        {
            owners.remove(document_id);
        }
        Ok(())
    }

    pub(crate) fn lock_session(&self) -> Result<MutexGuard<'_, ()>, AppError> {
        self.session_guard
            .lock()
            .map_err(|_| AppError::new(ErrorCode::Internal, "会话协调器不可用"))
    }
}

#[cfg(windows)]
impl Drop for InstanceGuard {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.handle as _);
        }
    }
}

pub fn acquire_instance() -> Result<InstanceStart, AppError> {
    let root = coordination_root()?;
    #[cfg(windows)]
    {
        let mut name = mutex_name(&root);
        name.push(0);
        unsafe {
            windows_sys::Win32::Foundation::SetLastError(0);
        }
        let handle = unsafe {
            windows_sys::Win32::System::Threading::CreateMutexW(std::ptr::null(), 1, name.as_ptr())
        };
        if handle.is_null() {
            return Err(AppError::new(
                ErrorCode::Internal,
                "无法建立 FeatherPad 单实例协调。",
            ));
        }
        let error = unsafe { windows_sys::Win32::Foundation::GetLastError() };
        if error == windows_sys::Win32::Foundation::ERROR_ALREADY_EXISTS {
            unsafe {
                windows_sys::Win32::Foundation::CloseHandle(handle);
            }
            return Ok(InstanceStart::Secondary(SecondaryOutcome {
                exit_code: 0,
                message: String::new(),
            }));
        }
        write_owner(&root)?;
        Ok(InstanceStart::Primary(InstanceGuard {
            root,
            handle: handle as isize,
        }))
    }
    #[cfg(not(windows))]
    {
        write_owner(&root)?;
        Ok(InstanceStart::Primary(InstanceGuard { root }))
    }
}

pub fn route_to_primary(args: &[String]) -> SecondaryOutcome {
    match route_to_primary_result(args) {
        Ok(message) => SecondaryOutcome {
            exit_code: 0,
            message,
        },
        Err(error) => SecondaryOutcome {
            exit_code: error.exit_code,
            message: error.message,
        },
    }
}

fn route_to_primary_result(args: &[String]) -> Result<String, crate::services::cli::CliError> {
    let action = crate::services::cli::parse(args)?;
    let run = match action {
        crate::services::cli::CliAction::Help => return Ok(crate::services::cli::HELP.to_owned()),
        crate::services::cli::CliAction::Run(run) => run,
    };
    let root = coordination_root().map_err(|error| {
        crate::services::cli::CliError::routing(format!("无法访问本地实例通道：{}", error.message))
    })?;
    let owner = wait_for_owner(&root).map_err(|error| {
        crate::services::cli::CliError::routing(format!("FeatherPad 主实例状态不可用：{error}"))
    })?;
    let request = inbox_request(run).map_err(|error| {
        crate::services::cli::CliError::routing(format!("无法准备实例请求：{}", error.message))
    })?;
    let request_id = request.request_id.clone();
    write_json_once(
        &requests_dir(&root).join(format!("{request_id}.json")),
        &request,
    )
    .map_err(|error| {
        crate::services::cli::CliError::routing(format!("实例请求写入失败：{}", error.message))
    })?;
    let ack = wait_for_ack(&root, &request_id).map_err(|error| {
        crate::services::cli::CliError::routing(format!("主实例未确认请求：{error}"))
    })?;
    if !ack.ok {
        return Err(crate::services::cli::CliError::routing(ack.message));
    }
    if !request.run.wait {
        if ack.partial {
            return Err(crate::services::cli::CliError::routing(ack.message));
        }
        return Ok("请求已交给 FeatherPad。".to_owned());
    }
    let deadline = Instant::now() + Duration::from_secs(7 * 24 * 60 * 60);
    while Instant::now() < deadline {
        if let Some(complete) = read_json::<CompleteAck>(&response_dir(&root), &request_id)? {
            return if complete.ok {
                Ok(complete.message)
            } else {
                Err(crate::services::cli::CliError::routing(complete.message))
            };
        }
        if !process_alive(owner.pid) {
            return Err(crate::services::cli::CliError::routing(
                "FeatherPad 主实例在等待文档关闭期间退出。",
            ));
        }
        thread::sleep(Duration::from_millis(100));
    }
    Err(crate::services::cli::CliError::routing(
        "等待文档关闭超时。",
    ))
}

fn inbox_request(run: CliRun) -> Result<InboxRequest, AppError> {
    let cwd = std::env::current_dir().map_err(io_error)?;
    Ok(InboxRequest {
        schema_version: REQUEST_SCHEMA,
        request_id: uuid::Uuid::new_v4().to_string(),
        cwd: cwd.to_string_lossy().into_owned(),
        run,
    })
}

pub(crate) fn next_primary_request(
    root: &Path,
) -> Result<Option<(PathBuf, InboxRequest)>, AppError> {
    let requests = requests_dir(root);
    fs::create_dir_all(&requests).map_err(io_error)?;
    let mut candidates = fs::read_dir(&requests)
        .map_err(io_error)?
        .filter_map(Result::ok)
        .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "json"))
        .map(|entry| entry.path())
        .collect::<Vec<_>>();
    candidates.sort();
    let Some(path) = candidates.into_iter().next() else {
        return Ok(None);
    };
    let claimed = path.with_extension("processing");
    fs::rename(&path, &claimed).map_err(io_error)?;
    let request = read_json_file::<InboxRequest>(&claimed)?;
    validate_inbox_request(&request)?;
    Ok(Some((claimed, request)))
}

pub fn acknowledge_request(
    root: &Path,
    request_id: &str,
    ok: bool,
    partial: bool,
    message: &str,
) -> Result<(), AppError> {
    validate_request_id(request_id)?;
    write_json_once(
        &ack_dir(root).join(format!("{request_id}.json")),
        &RouteAck {
            ok,
            partial,
            message: truncate_message(message),
        },
    )
}

pub fn complete_request(
    root: &Path,
    request_id: &str,
    ok: bool,
    message: &str,
) -> Result<(), AppError> {
    validate_request_id(request_id)?;
    write_json_once(
        &response_dir(root).join(format!("{request_id}.json")),
        &CompleteAck {
            ok,
            message: truncate_message(message),
        },
    )
}

pub fn resolve_targets(
    run: &CliRun,
    cwd: &Path,
    register: impl FnMut(&Path, GrantKind) -> Result<FileRef, AppError>,
) -> TargetResolution {
    let mut register = register;
    let mut targets = Vec::new();
    let mut failures = Vec::new();
    if let Some(goto) = &run.goto {
        match resolve_path(cwd, &goto.path).and_then(|path| {
            resolve_target(
                &path,
                RouteTargetKind::File,
                Some(goto.clone()),
                &mut register,
            )
        }) {
            Ok(target) => targets.push(target),
            Err(error) => failures.push(format!("{}: {}", goto.path, error.message)),
        }
    }
    for value in &run.paths {
        let result = resolve_path(cwd, value).and_then(|path| {
            let metadata = fs::metadata(&path).map_err(io_error)?;
            let kind = if metadata.is_file() {
                RouteTargetKind::File
            } else if metadata.is_dir() {
                RouteTargetKind::Directory
            } else {
                return Err(AppError::new(
                    ErrorCode::InvalidInput,
                    "CLI 路径既不是文件也不是目录",
                ));
            };
            resolve_target(&path, kind, None, &mut register)
        });
        match result {
            Ok(target) => targets.push(target),
            Err(error) => failures.push(format!("{value}: {}", error.message)),
        }
    }
    TargetResolution { targets, failures }
}

fn resolve_target(
    path: &Path,
    kind: RouteTargetKind,
    goto: Option<GotoTarget>,
    register: &mut impl FnMut(&Path, GrantKind) -> Result<FileRef, AppError>,
) -> Result<RoutedTarget, AppError> {
    let canonical = path.canonicalize().map_err(io_error)?;
    let reference = register(
        &canonical,
        if kind == RouteTargetKind::File {
            GrantKind::File
        } else {
            GrantKind::Directory
        },
    )?;
    Ok(RoutedTarget {
        path: canonical.to_string_lossy().into_owned(),
        kind,
        reference,
        display_name: canonical
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .filter(|name| !name.is_empty())
            .unwrap_or_else(|| canonical.to_string_lossy().into_owned()),
        goto,
    })
}

fn resolve_path(cwd: &Path, value: &str) -> Result<PathBuf, AppError> {
    if value.is_empty() || value.len() > 32_767 || value.contains('\0') {
        return Err(AppError::new(ErrorCode::InvalidInput, "CLI 路径无效。"));
    }
    let path = PathBuf::from(value);
    Ok(if path.is_absolute() {
        path
    } else {
        cwd.join(path)
    })
}

fn validate_inbox_request(request: &InboxRequest) -> Result<(), AppError> {
    if request.schema_version != REQUEST_SCHEMA
        || request.run.paths.len() > 64
        || request
            .run
            .paths
            .iter()
            .chain(request.run.goto.iter().map(|goto| &goto.path))
            .any(|path| path.is_empty() || path.len() > 32_767 || path.contains('\0'))
        || request.cwd.len() > 32_767
        || !Path::new(&request.cwd).is_absolute()
    {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "跨实例打开请求格式无效。",
        ));
    }
    validate_request_id(&request.request_id)
}

fn validate_request_id(value: &str) -> Result<(), AppError> {
    if uuid::Uuid::parse_str(value)
        .ok()
        .map(|parsed| parsed.to_string())
        .as_deref()
        == Some(value)
    {
        Ok(())
    } else {
        Err(AppError::new(
            ErrorCode::InvalidInput,
            "实例请求标识格式无效。",
        ))
    }
}

fn write_owner(root: &Path) -> Result<(), AppError> {
    let value = OwnerRecord {
        pid: std::process::id(),
    };
    let target = root.join("owner.json");
    let temporary = root.join(format!("owner-{}.tmp", uuid::Uuid::new_v4()));
    fs::write(
        &temporary,
        serde_json::to_vec(&value).map_err(|_| invalid())?,
    )
    .map_err(io_error)?;
    if target.exists() {
        fs::remove_file(&target).map_err(io_error)?;
    }
    fs::rename(&temporary, &target).map_err(io_error)
}

fn wait_for_owner(root: &Path) -> Result<OwnerRecord, String> {
    let deadline = Instant::now() + OWNER_WAIT;
    while Instant::now() < deadline {
        if let Ok(owner) = read_json_file::<OwnerRecord>(&root.join("owner.json")) {
            if owner.pid != std::process::id() && process_alive(owner.pid) {
                return Ok(owner);
            }
        }
        thread::sleep(POLL_INTERVAL);
    }
    Err("主进程记录超时".into())
}

fn wait_for_ack(root: &Path, request_id: &str) -> Result<RouteAck, String> {
    let deadline = Instant::now() + ACK_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(Some(ack)) = read_json::<RouteAck>(&ack_dir(root), request_id) {
            return Ok(ack);
        }
        thread::sleep(POLL_INTERVAL);
    }
    Err("确认超时".into())
}

fn read_json<T: for<'de> Deserialize<'de>>(
    directory: &Path,
    request_id: &str,
) -> Result<Option<T>, crate::services::cli::CliError> {
    let path = directory.join(format!("{request_id}.json"));
    match read_json_file(&path) {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.code == ErrorCode::NotFound => Ok(None),
        Err(error) => Err(crate::services::cli::CliError::routing(error.message)),
    }
}

fn read_json_file<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, AppError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Err(AppError::new(ErrorCode::NotFound, "实例消息不存在。"))
        }
        Err(error) => return Err(io_error(error)),
    };
    if !metadata.is_file() || metadata.len() > MAX_REQUEST_BYTES {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "实例消息类型或大小无效。",
        ));
    }
    let mut bytes = Vec::new();
    OpenOptions::new()
        .read(true)
        .open(path)
        .map_err(io_error)?
        .take(MAX_REQUEST_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "实例消息超过大小上限。",
        ));
    }
    serde_json::from_slice(&bytes)
        .map_err(|_| AppError::new(ErrorCode::InvalidInput, "实例消息 JSON 格式无效。"))
}

fn write_json_once<T: Serialize>(target: &Path, value: &T) -> Result<(), AppError> {
    let parent = target.parent().ok_or_else(invalid)?;
    fs::create_dir_all(parent).map_err(io_error)?;
    let temporary = target.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec(value).map_err(|_| invalid())?;
    if bytes.len() as u64 > MAX_REQUEST_BYTES {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "实例消息超过大小上限。",
        ));
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(io_error)?;
    file.write_all(&bytes).map_err(io_error)?;
    file.sync_all().map_err(io_error)?;
    drop(file);
    fs::rename(&temporary, target).map_err(io_error)
}

fn requests_dir(root: &Path) -> PathBuf {
    root.join("requests")
}

fn ack_dir(root: &Path) -> PathBuf {
    root.join("acks")
}

fn response_dir(root: &Path) -> PathBuf {
    root.join("responses")
}

fn mutex_name(root: &Path) -> Vec<u16> {
    let digest = Sha256::digest(root.to_string_lossy().to_lowercase().as_bytes());
    format!("Local\\FeatherPad-{}", hex_prefix(&digest, 16))
        .encode_utf16()
        .collect()
}

fn hex_prefix(bytes: &[u8], count: usize) -> String {
    bytes
        .iter()
        .take(count)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn truncate_message(message: &str) -> String {
    message.chars().take(4096).collect()
}

fn invalid() -> AppError {
    AppError::new(ErrorCode::InvalidInput, "实例消息无效。")
}

#[cfg(windows)]
fn process_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::STILL_ACTIVE;
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return false;
    }
    let mut code = 0;
    let ok = unsafe { GetExitCodeProcess(handle, &mut code) } != 0;
    unsafe {
        windows_sys::Win32::Foundation::CloseHandle(handle);
    }
    ok && code as i32 == STILL_ACTIVE
}

#[cfg(not(windows))]
fn process_alive(_pid: u32) -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::cli::WindowMode;

    #[test]
    fn request_messages_enforce_types_and_size() {
        let root =
            std::env::temp_dir().join(format!("featherpad-windows-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("large.json");
        fs::write(&path, vec![b'x'; MAX_REQUEST_BYTES as usize + 1]).unwrap();
        assert_eq!(
            read_json_file::<OwnerRecord>(&path).unwrap_err().code,
            ErrorCode::InvalidInput
        );
    }

    #[test]
    fn goto_alone_becomes_one_file_target() {
        let root =
            std::env::temp_dir().join(format!("featherpad-route-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let file = root.join("note.txt");
        fs::write(&file, b"one\ntwo\nthree").unwrap();
        let run = CliRun {
            window_mode: WindowMode::Reuse,
            wait: false,
            goto: Some(GotoTarget {
                path: file.to_string_lossy().into_owned(),
                line: 2,
                column: 2,
            }),
            paths: Vec::new(),
        };
        let mut next = 0;
        let resolution = resolve_targets(&run, &root, |_, kind| {
            assert!(kind == GrantKind::File);
            next += 1;
            Ok(FileRef {
                grant_id: format!("00000000-0000-4000-8000-{next:012}"),
                relative_path: String::new(),
            })
        });
        let targets = resolution.targets;
        assert!(resolution.failures.is_empty());
        assert_eq!(targets.len(), 1);
        assert_eq!(targets[0].goto.as_ref().unwrap().line, 2);
    }

    #[test]
    fn multiple_paths_keep_working_targets_when_one_path_is_invalid() {
        let root =
            std::env::temp_dir().join(format!("featherpad-route-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let first = root.join("first.txt");
        let second = root.join("second.txt");
        fs::write(&first, b"first").unwrap();
        fs::write(&second, b"second").unwrap();
        let run = CliRun {
            window_mode: WindowMode::Reuse,
            wait: true,
            goto: None,
            paths: vec![
                first.to_string_lossy().into_owned(),
                root.join("missing.txt").to_string_lossy().into_owned(),
                second.to_string_lossy().into_owned(),
            ],
        };
        let mut next = 0;
        let resolution = resolve_targets(&run, &root, |_, _| {
            next += 1;
            Ok(FileRef {
                grant_id: format!("00000000-0000-4000-8000-{next:012}"),
                relative_path: String::new(),
            })
        });
        assert_eq!(resolution.targets.len(), 2);
        assert_eq!(resolution.failures.len(), 1);
        assert!(resolution.failures[0].contains("missing.txt"));
    }
}
