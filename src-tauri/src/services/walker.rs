use super::files::FileService;
use crate::models::{io_error, AppError, ErrorCode, FileRef};
use globset::{Glob, GlobSet, GlobSetBuilder};
use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, HashSet},
    path::Path,
    sync::{Arc, Mutex},
    time::Instant,
};

pub const MAX_WALK_FILES: u32 = 100_000;
const MAX_WALK_DEPTH: usize = 64;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WalkWorkspaceRequest {
    pub request_id: String,
    pub roots: Vec<FileRef>,
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    pub respect_gitignore: bool,
    pub follow_directory_links: bool,
    pub include_hidden: bool,
    pub max_files: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkEntry {
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub display_name: String,
    pub display_path: String,
    pub size_bytes: u64,
    pub is_symlink: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkSkip {
    pub reason: String,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalkWorkspaceResult {
    pub request_id: String,
    pub entries: Vec<WalkEntry>,
    pub skipped: Vec<WalkSkip>,
    pub truncated: bool,
    pub cancelled: bool,
    pub elapsed_ms: u64,
}

#[derive(Default)]
pub struct WalkCoordinator {
    active: Mutex<HashSet<String>>,
    cancelled: Mutex<HashSet<String>>,
}

impl WalkCoordinator {
    pub fn start(&self, request_id: &str) -> Result<(), AppError> {
        if !canonical_uuid(request_id) {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "目录遍历请求标识无效。",
            ));
        }
        let mut active = self.active.lock().map_err(|_| busy())?;
        if active.len() >= 4 || !active.insert(request_id.to_owned()) {
            return Err(busy());
        }
        drop(active);
        let mut cancelled = self.cancelled.lock().map_err(|_| busy())?;
        cancelled.remove(request_id);
        Ok(())
    }

    pub fn finish(&self, request_id: &str) {
        if let Ok(mut active) = self.active.lock() {
            active.remove(request_id);
        }
        if let Ok(mut cancelled) = self.cancelled.lock() {
            cancelled.remove(request_id);
        }
    }

    pub fn cancel(&self, request_id: &str) -> Result<bool, AppError> {
        if !canonical_uuid(request_id) {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "目录遍历请求标识无效。",
            ));
        }
        let active = self.active.lock().map_err(|_| busy())?;
        if !active.contains(request_id) {
            return Ok(false);
        }
        let mut cancelled = self.cancelled.lock().map_err(|_| busy())?;
        if cancelled.len() >= 256 {
            cancelled.clear();
        }
        cancelled.insert(request_id.to_owned());
        Ok(true)
    }

    pub(crate) fn is_cancelled(&self, request_id: &str) -> bool {
        self.cancelled
            .lock()
            .map(|items| items.contains(request_id))
            .unwrap_or(true)
    }
}

impl FileService {
    pub fn walk_workspace(
        &self,
        request: WalkWorkspaceRequest,
        coordinator: Arc<WalkCoordinator>,
    ) -> Result<WalkWorkspaceResult, AppError> {
        validate_request(&request)?;
        let include = glob_set(&request.include)?;
        let exclude = glob_set(&request.exclude)?;
        let limit = request.max_files.unwrap_or(MAX_WALK_FILES);
        let started = Instant::now();
        let mut roots = Vec::new();
        let mut canonical_roots = HashSet::new();
        for reference in &request.roots {
            let path = self.grants.resolve_directory(reference)?;
            let key = normalized_key(&path);
            if canonical_roots.insert(key) {
                roots.push((reference.clone(), path));
            }
        }
        let mut entries = Vec::new();
        let mut skipped = BTreeMap::<String, u64>::new();
        let mut seen = HashSet::new();
        let mut truncated = false;
        let mut cancelled = false;

        'roots: for (reference, root) in roots {
            let user_exclude = exclude.clone();
            let user_include = include.clone();
            let filter_root = root.clone();
            let mut builder = WalkBuilder::new(&root);
            builder
                .hidden(!request.include_hidden)
                .max_depth(Some(MAX_WALK_DEPTH))
                .follow_links(request.follow_directory_links)
                .git_ignore(request.respect_gitignore)
                .git_global(request.respect_gitignore)
                .git_exclude(request.respect_gitignore)
                .parents(request.respect_gitignore)
                .same_file_system(false)
                .filter_entry(move |entry| {
                    if entry.depth() == 0 {
                        return true;
                    }
                    let Ok(relative) = entry.path().strip_prefix(&filter_root) else {
                        return false;
                    };
                    if has_default_ignored_component(relative) {
                        return false;
                    }
                    if user_exclude.is_match(relative) || user_exclude.is_match(entry.path()) {
                        return false;
                    }
                    if user_include.is_empty()
                        || user_include.is_match(relative)
                        || user_include.is_match(entry.path())
                        || entry.file_type().is_some_and(|kind| kind.is_dir())
                    {
                        return true;
                    }
                    false
                });

            for result in builder.build() {
                if coordinator.is_cancelled(&request.request_id) {
                    cancelled = true;
                    break 'roots;
                }
                let entry = match result {
                    Ok(entry) => entry,
                    Err(error) => {
                        let reason = if error.to_string().to_lowercase().contains("loop") {
                            "链接循环"
                        } else {
                            "无法读取"
                        };
                        increment(&mut skipped, reason);
                        continue;
                    }
                };
                if entry.depth() == 0 {
                    continue;
                }
                let file_type = match entry.file_type() {
                    Some(kind) => kind,
                    None => {
                        increment(&mut skipped, "无法读取类型");
                        continue;
                    }
                };
                if file_type.is_dir() {
                    continue;
                }
                if file_type.is_symlink() {
                    increment(&mut skipped, "未跟随链接");
                    continue;
                }
                let Ok(relative) = entry.path().strip_prefix(&root) else {
                    increment(&mut skipped, "越出授权根");
                    continue;
                };
                if has_hidden_component(relative) && !request.include_hidden {
                    increment(&mut skipped, "隐藏项");
                    continue;
                }
                if !include.is_empty()
                    && !include.is_match(relative)
                    && !include.is_match(entry.path())
                {
                    increment(&mut skipped, "不匹配包含规则");
                    continue;
                }
                if exclude.is_match(relative) || exclude.is_match(entry.path()) {
                    increment(&mut skipped, "匹配排除规则");
                    continue;
                }
                let canonical = entry.path().canonicalize().map_err(io_error)?;
                if !canonical.starts_with(&root) {
                    increment(&mut skipped, "越出授权根");
                    continue;
                }
                if !seen.insert(normalized_key(&canonical)) {
                    increment(&mut skipped, "重复文件身份");
                    continue;
                }
                let metadata = canonical.metadata().map_err(io_error)?;
                if !metadata.is_file() {
                    increment(&mut skipped, "非普通文件");
                    continue;
                }
                let relative_path = relative
                    .components()
                    .filter_map(|component| component.as_os_str().to_str())
                    .collect::<Vec<_>>()
                    .join("/");
                entries.push(WalkEntry {
                    reference: FileRef {
                        grant_id: reference.grant_id.clone(),
                        relative_path,
                    },
                    display_name: entry.file_name().to_string_lossy().into_owned(),
                    display_path: normalized_display(&canonical),
                    size_bytes: metadata.len(),
                    is_symlink: false,
                });
                if entries.len() >= limit as usize {
                    truncated = true;
                    break 'roots;
                }
            }
        }

        Ok(WalkWorkspaceResult {
            request_id: request.request_id,
            entries,
            skipped: skipped
                .into_iter()
                .map(|(reason, count)| WalkSkip { reason, count })
                .collect(),
            truncated,
            cancelled,
            elapsed_ms: started.elapsed().as_millis().try_into().unwrap_or(u64::MAX),
        })
    }
}

fn validate_request(request: &WalkWorkspaceRequest) -> Result<(), AppError> {
    if !canonical_uuid(&request.request_id)
        || request.roots.is_empty()
        || request.roots.len() > 16
        || request.include.len() > 256
        || request.exclude.len() > 256
        || request.include.iter().any(|item| !safe_pattern(item))
        || request.exclude.iter().any(|item| !safe_pattern(item))
        || request
            .max_files
            .is_some_and(|limit| limit == 0 || limit > MAX_WALK_FILES)
    {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "目录遍历范围或过滤规则无效。",
        ));
    }
    Ok(())
}

fn safe_pattern(value: &str) -> bool {
    !value.is_empty() && value.len() <= 1024 && !value.contains('\0')
}

fn glob_set(patterns: &[String]) -> Result<GlobSet, AppError> {
    let mut builder = GlobSetBuilder::new();
    for pattern in patterns {
        builder.add(
            Glob::new(pattern)
                .map_err(|_| AppError::new(ErrorCode::InvalidInput, "过滤 glob 格式无效。"))?,
        );
    }
    builder
        .build()
        .map_err(|_| AppError::new(ErrorCode::InvalidInput, "过滤 glob 格式无效。"))
}

fn has_default_ignored_component(path: &Path) -> bool {
    path.components().any(|component| {
        matches!(
            component.as_os_str().to_str(),
            Some(".git" | "node_modules" | "target" | "dist" | "build")
        )
    })
}

fn has_hidden_component(path: &Path) -> bool {
    path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|value| value.starts_with('.') && value != "." && value != "..")
    })
}

fn normalized_key(path: &Path) -> String {
    normalized_display(path).to_lowercase()
}

fn normalized_display(path: &Path) -> String {
    let value = path.to_string_lossy();
    if let Some(unc) = value.strip_prefix("\\\\?\\UNC\\") {
        format!("\\\\{unc}")
    } else {
        value.strip_prefix("\\\\?\\").unwrap_or(&value).to_owned()
    }
}

fn increment(map: &mut BTreeMap<String, u64>, reason: &str) {
    if !reason.is_empty() {
        *map.entry(reason.to_owned()).or_default() += 1;
    }
}

fn canonical_uuid(value: &str) -> bool {
    uuid::Uuid::parse_str(value)
        .ok()
        .map(|id| id.to_string())
        .as_deref()
        == Some(value)
}

fn busy() -> AppError {
    AppError::new(
        ErrorCode::Busy,
        "目录遍历任务已满或状态发生变化，请稍后重试。",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn filters_and_default_directories_are_counted() {
        let root = std::env::temp_dir().join(format!(
            "featherpad-walk-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("src/keep.txt"), b"keep").unwrap();
        fs::write(root.join("src/skip.log"), b"skip").unwrap();
        fs::write(root.join("node_modules/hidden.txt"), b"hidden").unwrap();
        let mut service = FileService::default();
        let grant = service
            .grants
            .register_selection(&root, super::super::grants::GrantKind::Directory)
            .unwrap();
        let request = WalkWorkspaceRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            roots: vec![grant],
            include: vec![],
            exclude: vec!["*.log".into()],
            respect_gitignore: true,
            follow_directory_links: false,
            include_hidden: false,
            max_files: None,
        };
        let result = service
            .walk_workspace(request, Arc::new(WalkCoordinator::default()))
            .unwrap();
        assert_eq!(
            result
                .entries
                .iter()
                .map(|entry| &entry.display_name)
                .collect::<Vec<_>>(),
            vec!["keep.txt"]
        );
        fs::remove_dir_all(root).unwrap();
    }
}
