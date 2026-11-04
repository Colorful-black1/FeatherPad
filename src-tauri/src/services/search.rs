use super::{
    files::FileService,
    text::decode_basic,
    walker::{WalkCoordinator, WalkWorkspaceRequest},
};
use crate::models::{AppError, ErrorCode, FileRef};
use regex::{Regex, RegexBuilder};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

pub const MAX_SEARCH_MATCHES: u32 = 10_000;
const MAX_FILE_MATCHES: usize = 1_000;
const MAX_SEARCH_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_RESULT_BYTES: usize = 50 * 1024 * 1024;
const MAX_SNIPPET_CHARS: usize = 2_000;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkspaceSearchRequest {
    pub request_id: String,
    pub roots: Vec<FileRef>,
    pub pattern: String,
    pub is_regex: bool,
    pub is_case_sensitive: bool,
    pub is_whole_word: bool,
    #[serde(default)]
    pub include: Vec<String>,
    #[serde(default)]
    pub exclude: Vec<String>,
    pub respect_gitignore: bool,
    pub follow_directory_links: bool,
    pub include_hidden: bool,
    pub max_matches: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub line: u32,
    pub column: u32,
    pub start: u32,
    pub end: u32,
    pub snippet: String,
    pub prefix_truncated: bool,
    pub suffix_truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFileResult {
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub display_name: String,
    pub display_path: String,
    pub revision: String,
    pub encoding: String,
    pub matches: Vec<SearchMatch>,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchSkip {
    pub reason: String,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceSearchResult {
    pub request_id: String,
    pub files: Vec<SearchFileResult>,
    pub skipped: Vec<SearchSkip>,
    pub total_matches: u32,
    pub scanned_files: u32,
    pub truncated: bool,
    pub cancelled: bool,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchProgress {
    pub request_id: String,
    pub sequence: u64,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<SearchFileResult>,
    pub scanned_files: u32,
    pub matched_files: u32,
    pub total_matches: u32,
    pub elapsed_ms: u64,
}

#[derive(Default)]
pub struct SearchCoordinator {
    active: Mutex<HashMap<String, Arc<WalkCoordinator>>>,
}

impl SearchCoordinator {
    pub fn start(&self, request_id: &str) -> Result<Arc<WalkCoordinator>, AppError> {
        let walker = Arc::new(WalkCoordinator::default());
        walker.start(request_id)?;
        let mut active = self.active.lock().map_err(|_| busy())?;
        if active.len() >= 2 || active.contains_key(request_id) {
            walker.finish(request_id);
            return Err(busy());
        }
        active.insert(request_id.to_owned(), walker.clone());
        Ok(walker)
    }

    pub fn finish(&self, request_id: &str) {
        let walker = self
            .active
            .lock()
            .ok()
            .and_then(|mut active| active.remove(request_id));
        if let Some(walker) = walker {
            walker.finish(request_id);
        }
    }

    pub fn cancel(&self, request_id: &str) -> Result<bool, AppError> {
        let walker = self
            .active
            .lock()
            .map_err(|_| busy())?
            .get(request_id)
            .cloned();
        walker.map_or(Ok(false), |walker| walker.cancel(request_id))
    }

    fn is_cancelled(&self, request_id: &str) -> bool {
        self.active
            .lock()
            .ok()
            .and_then(|active| active.get(request_id).cloned())
            .is_none_or(|walker| walker.is_cancelled(request_id))
    }
}

impl FileService {
    pub fn search_workspace(
        &self,
        request: WorkspaceSearchRequest,
        coordinator: Arc<SearchCoordinator>,
        walker: Arc<WalkCoordinator>,
        progress: impl Fn(SearchProgress) + Send + Sync,
    ) -> Result<WorkspaceSearchResult, AppError> {
        validate_search(&request)?;
        let started = Instant::now();
        let regex = compile_pattern(&request)?;
        let limit = request.max_matches.unwrap_or(MAX_SEARCH_MATCHES);
        let mut files = Vec::new();
        let mut skipped = BTreeMap::<String, u64>::new();
        let mut total_matches = 0u32;
        let mut scanned_files = 0u32;
        let mut result_bytes = 0usize;
        let mut truncated = false;
        let mut cancelled = false;
        let mut last_progress = Instant::now();
        let mut sequence = 0u64;
        let mut sent_files = 0usize;

        let walked = self.visit_workspace(
            WalkWorkspaceRequest {
                request_id: request.request_id.clone(),
                roots: request.roots.clone(),
                include: request.include.clone(),
                exclude: request.exclude.clone(),
                respect_gitignore: request.respect_gitignore,
                follow_directory_links: request.follow_directory_links,
                include_hidden: request.include_hidden,
                max_files: Some(100_000),
            },
            walker,
            |entry| {
                if coordinator.is_cancelled(&request.request_id) {
                    cancelled = true;
                    truncated = true;
                    return false;
                }
                if entry.size_bytes >= MAX_SEARCH_FILE_BYTES {
                    increment(&mut skipped, "文件达到20MiB上限");
                    return true;
                }
                let resolved = match self.grants.resolve_entry(&entry.reference) {
                    Ok(resolved) => resolved,
                    Err(_) => {
                        increment(&mut skipped, "授权或路径已变化");
                        return true;
                    }
                };
                let bytes = match std::fs::read(&resolved.path) {
                    Ok(bytes) => bytes,
                    Err(_) => {
                        increment(&mut skipped, "无法读取");
                        return true;
                    }
                };
                scanned_files = scanned_files.saturating_add(1);
                let decoded = match decode_basic(&bytes) {
                    Ok(decoded) => decoded,
                    Err(error) if error.code == ErrorCode::EncodingRequired => {
                        increment(&mut skipped, "需要其他编码");
                        return true;
                    }
                    Err(_) => {
                        increment(&mut skipped, "编码有损");
                        return true;
                    }
                };
                if decoded
                    .text
                    .chars()
                    .take(8 * 1024)
                    .any(|character| character == '\0')
                {
                    increment(&mut skipped, "二进制");
                    return true;
                }
                let mut matches = Vec::new();
                let mut file_truncated = false;
                for found in regex.find_iter(&decoded.text) {
                    if total_matches >= limit
                        || result_bytes >= MAX_RESULT_BYTES
                        || matches.len() >= MAX_FILE_MATCHES
                    {
                        truncated = true;
                        file_truncated = true;
                        break;
                    }
                    let detail = match_match(&decoded.text, found.start(), found.end());
                    result_bytes = result_bytes
                        .saturating_add(entry.display_path.len())
                        .saturating_add(detail.snippet.len())
                        .saturating_add(128);
                    if result_bytes >= MAX_RESULT_BYTES {
                        truncated = true;
                        file_truncated = true;
                        break;
                    }
                    matches.push(detail);
                    total_matches = total_matches.saturating_add(1);
                }
                if !matches.is_empty() {
                    let matched = SearchFileResult {
                        reference: entry.reference,
                        display_name: entry.display_name,
                        display_path: entry.display_path,
                        revision: format!("{:x}", Sha256::digest(&bytes)),
                        encoding: decoded.encoding.to_owned(),
                        matches,
                        truncated: file_truncated,
                    };
                    files.push(matched);
                }
                if total_matches >= limit || result_bytes >= MAX_RESULT_BYTES {
                    truncated = true;
                    return false;
                }
                if (sent_files == 0 && !files.is_empty())
                    || last_progress.elapsed() >= Duration::from_millis(150)
                {
                    sequence += 1;
                    let batch_end = files.len().min(sent_files + 25);
                    progress(SearchProgress {
                        sequence,
                        files: files[sent_files..batch_end].to_vec(),
                        request_id: request.request_id.clone(),
                        scanned_files,
                        matched_files: files.len().try_into().unwrap_or(u32::MAX),
                        total_matches,
                        elapsed_ms: elapsed(started),
                    });
                    sent_files = batch_end;
                    last_progress = Instant::now();
                }
                true
            },
        )?;
        cancelled |= walked.cancelled;
        truncated |= walked.truncated;
        for skip in walked.skipped {
            *skipped.entry(skip.reason).or_default() += skip.count;
        }
        if walked.truncated {
            *skipped.entry("目录条目上限".into()).or_default() += 1;
        }

        sequence += 1;
        progress(SearchProgress {
            sequence,
            files: files[sent_files..files.len().min(sent_files + 25)].to_vec(),
            request_id: request.request_id.clone(),
            scanned_files,
            matched_files: files.len().try_into().unwrap_or(u32::MAX),
            total_matches,
            elapsed_ms: elapsed(started),
        });
        Ok(WorkspaceSearchResult {
            request_id: request.request_id,
            files,
            skipped: skipped
                .into_iter()
                .map(|(reason, count)| SearchSkip { reason, count })
                .collect(),
            total_matches,
            scanned_files,
            truncated,
            cancelled,
            elapsed_ms: elapsed(started),
        })
    }
}

fn compile_pattern(request: &WorkspaceSearchRequest) -> Result<Regex, AppError> {
    compile_query(
        &request.pattern,
        request.is_regex,
        request.is_case_sensitive,
        request.is_whole_word,
    )
}

pub(crate) fn compile_query(
    pattern: &str,
    is_regex: bool,
    is_case_sensitive: bool,
    is_whole_word: bool,
) -> Result<Regex, AppError> {
    let mut normalized = if is_regex {
        pattern.to_owned()
    } else {
        regex::escape(pattern)
    };
    if is_whole_word {
        normalized = format!(r"(?u:\b(?:{normalized})\b)");
    }
    RegexBuilder::new(&normalized)
        .case_insensitive(!is_case_sensitive)
        .multi_line(true)
        .size_limit(10 * 1024 * 1024)
        .dfa_size_limit(10 * 1024 * 1024)
        .build()
        .map_err(|error| {
            AppError::new(
                ErrorCode::InvalidPattern,
                &format!("搜索表达式无效：{}", first_line(&error.to_string())),
            )
        })
}

pub(crate) fn match_match(text: &str, start: usize, end: usize) -> SearchMatch {
    let line_start = text[..start].rfind('\n').map_or(0, |index| index + 1);
    let line_end = text[end..]
        .find('\n')
        .map_or(text.len(), |index| end + index);
    let line = &text[line_start..line_end];
    let match_start = start.saturating_sub(line_start);
    let match_end = end.saturating_sub(line_start);
    let chars = line.chars().collect::<Vec<_>>();
    let match_start_chars = line[..match_start].chars().count();
    let match_end_chars = line[..match_end].chars().count();
    let context = MAX_SNIPPET_CHARS.saturating_sub(match_end_chars - match_start_chars) / 2;
    let snippet_start = match_start_chars.saturating_sub(context);
    let snippet_end = (match_end_chars + context).min(chars.len());
    SearchMatch {
        line: (text[..start].bytes().filter(|byte| *byte == b'\n').count() + 1)
            .try_into()
            .unwrap_or(u32::MAX),
        column: (match_start_chars + 1).try_into().unwrap_or(u32::MAX),
        start: start.try_into().unwrap_or(u32::MAX),
        end: end.try_into().unwrap_or(u32::MAX),
        snippet: chars[snippet_start..snippet_end].iter().collect(),
        prefix_truncated: snippet_start > 0,
        suffix_truncated: snippet_end < chars.len(),
    }
}

fn validate_search(request: &WorkspaceSearchRequest) -> Result<(), AppError> {
    if request.pattern.is_empty()
        || request.pattern.len() > 10 * 1024
        || request.pattern.contains('\0')
        || request.roots.is_empty()
        || request.roots.len() > 16
        || request.include.len() > 256
        || request.exclude.len() > 256
        || request
            .max_matches
            .is_some_and(|limit| limit == 0 || limit > MAX_SEARCH_MATCHES)
    {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "搜索范围、表达式或结果上限无效。",
        ));
    }
    Ok(())
}

fn increment(map: &mut BTreeMap<String, u64>, reason: &str) {
    *map.entry(reason.to_owned()).or_default() += 1;
}

fn elapsed(started: Instant) -> u64 {
    started.elapsed().as_millis().try_into().unwrap_or(u64::MAX)
}

fn first_line(message: &str) -> &str {
    message.lines().next().unwrap_or("请检查语法")
}

fn busy() -> AppError {
    AppError::new(ErrorCode::Busy, "搜索任务已满或状态发生变化，请稍后重试。")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::{encoding::encode_text, grants::GrantKind};
    use std::{fs, path::PathBuf};

    #[test]
    fn first_matching_batch_arrives_before_completion_and_cancel_keeps_it() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../.artifacts/T501")
            .join(format!("stream-search-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        for index in 0..60 {
            fs::write(root.join(format!("item-{index:03}.txt")), b"alpha\n").unwrap();
        }
        let mut service = FileService::default();
        let grant = service
            .grants
            .register_selection(&root, GrantKind::Directory)
            .unwrap();
        let request_id = uuid::Uuid::new_v4().to_string();
        let coordinator = Arc::new(SearchCoordinator::default());
        let walker = coordinator.start(&request_id).unwrap();
        let batches = Mutex::new(Vec::new());
        let result = service
            .search_workspace(
                WorkspaceSearchRequest {
                    request_id: request_id.clone(),
                    roots: vec![grant],
                    pattern: "alpha".into(),
                    is_regex: false,
                    is_case_sensitive: true,
                    is_whole_word: false,
                    include: vec![],
                    exclude: vec![],
                    respect_gitignore: false,
                    follow_directory_links: false,
                    include_hidden: false,
                    max_matches: None,
                },
                coordinator.clone(),
                walker,
                |batch| {
                    if !batch.files.is_empty() {
                        assert_eq!(batch.scanned_files, 1);
                        coordinator.cancel(&request_id).unwrap();
                    }
                    batches.lock().unwrap().push(batch);
                },
            )
            .unwrap();
        coordinator.finish(&request_id);
        let batches = batches.lock().unwrap();
        assert_eq!(batches[0].sequence, 1);
        assert_eq!(batches[0].files.len(), 1);
        assert!(batches
            .windows(2)
            .all(|pair| pair[1].sequence == pair[0].sequence + 1));
        assert!(result.cancelled);
        assert_eq!(result.scanned_files, 1);
        assert_eq!(result.files.len(), 1);
        assert_eq!(result.files[0].revision, batches[0].files[0].revision);
        assert!(!result
            .skipped
            .iter()
            .any(|skip| skip.reason == "目录条目上限"));
    }

    #[test]
    fn searches_unicode_text_with_limits_and_revision() {
        let root = std::env::temp_dir().join(format!(
            "featherpad-search-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/a.txt"), "第一行\nAlpha alpha\n").unwrap();
        fs::write(root.join("src/b.log"), "Alpha\n").unwrap();
        fs::write(
            root.join("src/c.txt"),
            encode_text("Leading\nAlpha\n", "utf-16le", "utf16le").unwrap(),
        )
        .unwrap();
        let mut service = FileService::default();
        let grant = service
            .grants
            .register_selection(&root, GrantKind::Directory)
            .unwrap();
        let request_id = uuid::Uuid::new_v4().to_string();
        let coordinator = Arc::new(SearchCoordinator::default());
        let walker = coordinator.start(&request_id).unwrap();
        let result = service
            .search_workspace(
                WorkspaceSearchRequest {
                    request_id: request_id.clone(),
                    roots: vec![grant],
                    pattern: "alpha".into(),
                    is_regex: false,
                    is_case_sensitive: false,
                    is_whole_word: true,
                    include: vec!["*.txt".into()],
                    exclude: vec![],
                    respect_gitignore: false,
                    follow_directory_links: false,
                    include_hidden: false,
                    max_matches: Some(10),
                },
                coordinator.clone(),
                walker,
                |_| {},
            )
            .unwrap();
        coordinator.finish(&request_id);
        assert_eq!(result.total_matches, 3);
        assert_eq!(result.files.len(), 2);
        let first = result
            .files
            .iter()
            .find(|file| file.display_name == "a.txt")
            .unwrap();
        assert_eq!(first.matches[0].line, 2);
        assert_eq!(first.matches[0].column, 1);
        assert_eq!(first.revision.len(), 64);
        assert!(result
            .files
            .iter()
            .any(|file| file.display_name == "c.txt" && file.encoding == "utf-16le"));
        fs::remove_dir_all(root).unwrap();
    }
}
