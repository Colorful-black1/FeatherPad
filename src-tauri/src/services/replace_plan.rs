use super::{
    encoding::encode_text,
    files::FileService,
    save_journal::write_new_verified,
    search::{compile_query, match_match},
    text::decode_basic,
    walker::{WalkCoordinator, WalkWorkspaceRequest},
    windows_file,
};
use crate::models::{AppError, ErrorCode, FileRef};
use regex::Regex;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

const MAX_PLAN_FILE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_PLAN_MATCHES: usize = 10_000;
const MAX_PLAN_TOTAL_BYTES: u64 = 256 * 1024 * 1024;
const PLAN_TTL_MS: i64 = 10 * 60 * 1_000;
const PREVIEW_CONTEXT_LINES: usize = 2;
const MAX_PREVIEW_HUNKS: usize = 8;
const MAX_PREVIEW_HUNK_LINES: usize = 60;
const MAX_PREVIEW_LINE_CHARS: usize = 500;
const MAX_PREVIEW_LINES: usize = 240;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CreateReplacePlanRequest {
    pub request_id: String,
    pub roots: Vec<FileRef>,
    pub pattern: String,
    pub replacement: String,
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
    #[serde(default)]
    pub dirty_paths: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ReplaceFileState {
    Ready,
    DirtySkipped,
    ReadOnly,
    Conflict,
    Unsupported,
    Committed,
    RolledBack,
    RollbackConflict,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePreviewHunk {
    pub start_line: u32,
    pub after_start_line: u32,
    pub before: Vec<String>,
    pub after: Vec<String>,
    pub match_lines: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacePlanFile {
    pub id: String,
    #[serde(rename = "ref")]
    pub reference: FileRef,
    pub display_name: String,
    pub display_path: String,
    pub state: ReplaceFileState,
    pub reason: Option<String>,
    pub before_revision: String,
    pub after_revision: Option<String>,
    pub before_hash: String,
    pub after_hash: String,
    pub encoding: String,
    pub matches: u32,
    pub preview_before: String,
    pub preview_after: String,
    #[serde(default)]
    pub match_lines: Vec<u32>,
    #[serde(default)]
    pub preview_hunks: Vec<ReplacePreviewHunk>,
    pub before_snapshot_ref: Option<String>,
    pub after_snapshot_ref: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplacementPlan {
    pub schema_version: u32,
    pub plan_id: String,
    pub confirmation_token: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub replacement: String,
    pub files: Vec<ReplacePlanFile>,
    pub total_matches: u32,
    pub truncated: bool,
    pub skipped: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CommitReplacePlanRequest {
    pub plan_id: String,
    pub confirmation_token: String,
    pub selected: Vec<FileRef>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReplaceBatchOutcome {
    pub batch_id: String,
    pub status: String,
    pub succeeded: Vec<String>,
    pub failed: Vec<String>,
    pub remaining: Vec<String>,
    pub rollback_journal_ref: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RollbackReplaceBatchRequest {
    pub batch_id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RollbackBatchOutcome {
    pub batch_id: String,
    pub status: String,
    pub restored: Vec<String>,
    pub conflicts: Vec<String>,
    pub failed: Vec<String>,
    pub rollback_journal_ref: String,
}

struct MatchInfo {
    start_line: usize,
    end_line: usize,
    delta_before: isize,
}

struct HunkRange {
    start_line: usize,
    end_line: usize,
    delta_before: isize,
}

fn line_starts(text: &str) -> Vec<usize> {
    let bytes = text.as_bytes();
    let mut starts = vec![0];
    for (index, byte) in bytes.iter().enumerate() {
        match byte {
            b'\n' => starts.push(index + 1),
            b'\r' if bytes.get(index + 1) != Some(&b'\n') => starts.push(index + 1),
            _ => {}
        }
    }
    starts
}

fn line_index(starts: &[usize], offset: usize) -> usize {
    match starts.binary_search(&offset) {
        Ok(index) => index,
        Err(index) => index.saturating_sub(1),
    }
}

fn count_line_breaks(text: &str) -> isize {
    let mut count = 0isize;
    let mut chars = text.chars().peekable();
    while let Some(character) = chars.next() {
        match character {
            '\r' => {
                count = count.saturating_add(1);
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
            }
            '\n' => count = count.saturating_add(1),
            _ => {}
        }
    }
    count
}

fn preview_line(line: &str) -> String {
    let mut chars = line.chars();
    let mut output: String = chars.by_ref().take(MAX_PREVIEW_LINE_CHARS).collect();
    if chars.next().is_some() {
        output.push('…');
    }
    output
}

fn preview_lines(text: &str) -> Vec<String> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut lines: Vec<String> = normalized.split('\n').map(preview_line).collect();
    if normalized.ends_with('\n') {
        lines.pop();
    }
    if lines.len() > MAX_PREVIEW_LINES {
        lines.truncate(MAX_PREVIEW_LINES);
        lines.push("…".into());
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn hunk_text(text: &str, starts: &[usize], start_line: usize, end_line: usize) -> String {
    let Some(&start) = starts.get(start_line) else {
        return String::new();
    };
    let end = starts
        .get(end_line + 1)
        .copied()
        .unwrap_or(text.len())
        .min(text.len());
    if start >= end {
        return String::new();
    }
    text[start..end].to_owned()
}

fn build_replace_preview(
    before: &str,
    matches: &[(usize, usize)],
    regex: &Regex,
    template: &str,
) -> (Vec<u32>, Vec<ReplacePreviewHunk>) {
    let starts = line_starts(before);
    let line_count = starts.len();
    let mut infos = Vec::with_capacity(matches.len());
    let mut cumulative_delta = 0isize;
    for &(start, end) in matches {
        let start_line = line_index(&starts, start.min(before.len()));
        let end_line = if end > start {
            line_index(&starts, end.saturating_sub(1).min(before.len()))
        } else {
            start_line
        };
        let matched = before.get(start..end).unwrap_or("");
        let replaced = regex.replace(matched, template);
        let delta = count_line_breaks(&replaced).saturating_sub(count_line_breaks(matched));
        infos.push(MatchInfo {
            start_line,
            end_line,
            delta_before: cumulative_delta,
        });
        cumulative_delta = cumulative_delta.saturating_add(delta);
    }

    let mut match_lines = Vec::new();
    for info in &infos {
        let line = u32::try_from(info.start_line + 1).unwrap_or(u32::MAX);
        if match_lines.last().copied() != Some(line) {
            match_lines.push(line);
        }
    }

    let mut ranges: Vec<HunkRange> = Vec::new();
    for info in &infos {
        let span = info.end_line.saturating_sub(info.start_line);
        if span > MAX_PREVIEW_HUNK_LINES.saturating_sub(PREVIEW_CONTEXT_LINES * 2) {
            continue;
        }
        let start_line = info.start_line.saturating_sub(PREVIEW_CONTEXT_LINES);
        let end_line = info
            .end_line
            .saturating_add(PREVIEW_CONTEXT_LINES)
            .min(line_count.saturating_sub(1));
        if let Some(last) = ranges.last_mut() {
            if start_line <= last.end_line.saturating_add(1)
                && end_line.saturating_sub(last.start_line) < MAX_PREVIEW_HUNK_LINES
            {
                last.end_line = last.end_line.max(end_line);
                continue;
            }
        }
        if ranges.len() >= MAX_PREVIEW_HUNKS {
            break;
        }
        ranges.push(HunkRange {
            start_line,
            end_line,
            delta_before: info.delta_before,
        });
    }

    let mut hunks = Vec::with_capacity(ranges.len());
    for range in ranges {
        let text = hunk_text(before, &starts, range.start_line, range.end_line);
        let after = regex.replace_all(&text, template).into_owned();
        let hunk_match_lines = match_lines
            .iter()
            .copied()
            .filter(|line| {
                *line as usize > range.start_line && *line as usize <= range.end_line + 1
            })
            .collect();
        let after_start = (range.start_line as isize + 1 + range.delta_before).max(1);
        hunks.push(ReplacePreviewHunk {
            start_line: u32::try_from(range.start_line + 1).unwrap_or(u32::MAX),
            after_start_line: u32::try_from(after_start).unwrap_or(1),
            before: preview_lines(&text),
            after: preview_lines(&after),
            match_lines: hunk_match_lines,
        });
    }
    (match_lines, hunks)
}

impl FileService {
    pub fn create_replace_plan(
        &self,
        request: CreateReplacePlanRequest,
        store_root: &Path,
        walker: Arc<WalkCoordinator>,
    ) -> Result<ReplacementPlan, AppError> {
        validate_plan_request(&request)?;
        let regex = compile_query(
            &request.pattern,
            request.is_regex,
            request.is_case_sensitive,
            request.is_whole_word,
        )?;
        let template =
            prepare_replacement_template(&request.replacement, request.is_regex, &regex)?;
        let walked = self.walk_workspace(
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
        )?;
        let plan_id = uuid::Uuid::new_v4().to_string();
        let plan_dir = store_root.join(&plan_id);
        fs::create_dir_all(plan_dir.join("before")).map_err(crate::models::io_error)?;
        fs::create_dir_all(plan_dir.join("after")).map_err(crate::models::io_error)?;
        let dirty_paths = request
            .dirty_paths
            .iter()
            .map(|path| path.replace('/', "\\").to_lowercase())
            .collect::<HashSet<_>>();
        let mut files = Vec::new();
        let mut total_matches = 0usize;
        let mut total_bytes = 0u64;
        let mut truncated = walked.truncated;
        let mut skipped = Vec::new();
        for entry in walked.entries {
            if files.len() >= 10_000
                || total_matches >= MAX_PLAN_MATCHES
                || total_bytes >= MAX_PLAN_TOTAL_BYTES
            {
                truncated = true;
                break;
            }
            if entry.size_bytes >= MAX_PLAN_FILE_BYTES {
                skipped.push(format!("{}：文件达到20MiB上限", entry.display_path));
                continue;
            }
            let resolved = match self.grants.resolve_entry(&entry.reference) {
                Ok(resolved) => resolved,
                Err(_) => {
                    skipped.push(format!("{}：授权或路径已变化", entry.display_path));
                    continue;
                }
            };
            let before_bytes = match fs::read(&resolved.path) {
                Ok(bytes) => bytes,
                Err(_) => {
                    skipped.push(format!("{}：无法读取", entry.display_path));
                    continue;
                }
            };
            let before = match decode_basic(&before_bytes) {
                Ok(decoded) => decoded,
                Err(_) => {
                    skipped.push(format!("{}：编码不确定或有损", entry.display_path));
                    continue;
                }
            };
            if before
                .text
                .chars()
                .take(8 * 1024)
                .any(|character| character == '\0')
            {
                skipped.push(format!("{}：二进制文件", entry.display_path));
                continue;
            }
            let mut match_ranges = Vec::new();
            let mut file_matches = 0usize;
            for found in regex.find_iter(&before.text) {
                match_ranges.push((found.start(), found.end()));
                file_matches = file_matches.saturating_add(1);
                // One extra match is enough to reject the file safely without
                // collecting an unbounded match list for a 20MiB input.
                if file_matches > 1_000 {
                    break;
                }
            }
            let Some(&(first_start, first_end)) = match_ranges.first() else {
                continue;
            };
            if file_matches > 1_000 {
                truncated = true;
                skipped.push(format!(
                    "{}：匹配超过单文件1000上限，本次计划不处理该文件",
                    entry.display_path
                ));
                continue;
            }
            if total_matches.saturating_add(file_matches) > MAX_PLAN_MATCHES {
                truncated = true;
                skipped.push(format!(
                    "{}：加入后超过计划10000匹配上限，本次计划不处理该文件",
                    entry.display_path
                ));
                continue;
            }
            total_matches = total_matches.saturating_add(file_matches);
            let after_text = regex
                .replace_all(&before.text, template.as_str())
                .into_owned();
            // Replacement must preserve the source byte encoding and BOM. The
            // decoded text is UTF-8 internally, but writing its bytes directly
            // would silently convert UTF-16 files during a search/replace.
            let after_bytes = encode_text(&after_text, before.encoding, before.bom)?;
            total_bytes = total_bytes
                .saturating_add(before_bytes.len() as u64)
                .saturating_add(after_bytes.len() as u64);
            if total_bytes > MAX_PLAN_TOTAL_BYTES {
                return Err(AppError::new(
                    ErrorCode::TooLarge,
                    "替换计划备份将超过256MiB上限，尚未修改任何源文件。",
                ));
            }
            let id = uuid::Uuid::new_v4().to_string();
            let before_hash = digest(&before_bytes);
            let after_hash = digest(&after_bytes);
            let dirty = dirty_paths.contains(&entry.display_path.replace('/', "\\").to_lowercase());
            let read_only = resolved.metadata.permissions().readonly();
            let (state, reason) = if dirty {
                (
                    ReplaceFileState::DirtySkipped,
                    Some("文件有未保存缓冲；保存或放弃后重新预览。".into()),
                )
            } else if read_only {
                (
                    ReplaceFileState::ReadOnly,
                    Some("文件为只读；计划不会修改该文件。".into()),
                )
            } else {
                (ReplaceFileState::Ready, None)
            };
            let before_ref = (state == ReplaceFileState::Ready).then(|| format!("before/{id}.bin"));
            let after_ref = (state == ReplaceFileState::Ready).then(|| format!("after/{id}.bin"));
            if let Some(relative) = &before_ref {
                write_new_verified(&plan_dir.join(relative), &before_bytes)?;
            }
            if let Some(relative) = &after_ref {
                write_new_verified(&plan_dir.join(relative), &after_bytes)?;
            }
            let (match_lines, preview_hunks) =
                build_replace_preview(&before.text, &match_ranges, &regex, template.as_str());
            files.push(ReplacePlanFile {
                id,
                reference: entry.reference,
                display_name: entry.display_name,
                display_path: entry.display_path,
                state,
                reason,
                before_revision: before_hash.clone(),
                after_revision: None,
                before_hash,
                after_hash,
                encoding: before.encoding.to_owned(),
                matches: file_matches.try_into().unwrap_or(u32::MAX),
                preview_before: before.text.chars().take(2_000).collect(),
                preview_after: after_text.chars().take(2_000).collect(),
                match_lines,
                preview_hunks,
                before_snapshot_ref: before_ref,
                after_snapshot_ref: after_ref,
            });
            let _ = match_match(&before.text, first_start, first_end);
        }
        if walked.truncated {
            skipped.push("目录条目达到上限，计划不完整。".into());
        }
        let now = now_millis()?;
        let plan = ReplacementPlan {
            schema_version: 1,
            plan_id,
            confirmation_token: uuid::Uuid::new_v4().to_string(),
            created_at: now,
            expires_at: now.saturating_add(PLAN_TTL_MS),
            replacement: request.replacement,
            files,
            total_matches: total_matches.try_into().unwrap_or(u32::MAX),
            truncated,
            skipped,
        };
        let mut manifest = plan.clone();
        for file in &mut manifest.files {
            file.match_lines.clear();
            file.preview_hunks.clear();
        }
        persist_manifest(&plan_dir, &manifest)?;
        Ok(plan)
    }

    pub fn commit_replace_plan(
        &mut self,
        request: CommitReplacePlanRequest,
        store_root: &Path,
    ) -> Result<ReplaceBatchOutcome, AppError> {
        let plan_dir = plan_directory(store_root, &request.plan_id)?;
        let mut plan = load_manifest(&plan_dir)?;
        if plan.confirmation_token != request.confirmation_token {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "替换确认令牌不匹配，计划未写入。",
            ));
        }
        if now_millis()? > plan.expires_at {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "替换计划已过期，请重新预览；源文件未修改。",
            ));
        }
        let selected = request
            .selected
            .iter()
            .map(reference_key)
            .collect::<HashSet<_>>();
        let ready = plan
            .files
            .iter()
            .filter(|file| {
                file.state == ReplaceFileState::Ready
                    && selected.contains(&reference_key(&file.reference))
            })
            .cloned()
            .collect::<Vec<_>>();
        if ready.is_empty() || ready.len() != selected.len() {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "替换选择包含不可提交或不属于该计划的文件。",
            ));
        }
        // Preflight every selected file before the first source write.
        for file in &ready {
            let path = self.grants.resolve_entry(&file.reference)?.path;
            let bytes = fs::read(&path).map_err(crate::models::io_error)?;
            if digest(&bytes) != file.before_hash {
                return Err(AppError::new(
                    ErrorCode::Conflict,
                    &format!("{} 在预览后已变化；整批未开始。", file.display_path),
                ));
            }
        }
        let mut succeeded = Vec::new();
        let mut failed = Vec::new();
        let mut remaining = ready
            .iter()
            .map(|file| file.display_path.clone())
            .collect::<Vec<_>>();
        for file in ready {
            let result = self.apply_plan_file(&plan_dir, &file);
            let display = file.display_path.clone();
            match result {
                Ok(after_revision) => {
                    if let Some(stored) = plan.files.iter_mut().find(|item| item.id == file.id) {
                        stored.state = ReplaceFileState::Committed;
                        stored.after_revision = Some(after_revision);
                    }
                    succeeded.push(display.clone());
                    remaining.retain(|item| item != &display);
                    persist_manifest(&plan_dir, &plan)?;
                }
                Err(error) => {
                    failed.push(format!("{display}：{}", error.message));
                    remaining.retain(|item| item != &display);
                    persist_manifest(&plan_dir, &plan)?;
                    break;
                }
            }
        }
        let status = if remaining.is_empty() && failed.is_empty() {
            "completed"
        } else if succeeded.is_empty() {
            "failed"
        } else {
            "partial"
        };
        Ok(ReplaceBatchOutcome {
            batch_id: plan.plan_id.clone(),
            status: status.into(),
            succeeded,
            failed,
            remaining,
            rollback_journal_ref: format!("replacement-plans/{}", plan.plan_id),
        })
    }

    pub fn rollback_replace_batch(
        &self,
        request: RollbackReplaceBatchRequest,
        store_root: &Path,
    ) -> Result<RollbackBatchOutcome, AppError> {
        let plan_dir = plan_directory(store_root, &request.batch_id)?;
        let mut plan = load_manifest(&plan_dir)?;
        let mut restored = Vec::new();
        let mut conflicts = Vec::new();
        let mut failed = Vec::new();
        for index in 0..plan.files.len() {
            if plan.files[index].state != ReplaceFileState::Committed {
                continue;
            }
            let file = plan.files[index].clone();
            let path = match self.grants.resolve_entry(&file.reference) {
                Ok(resolved) => resolved.path,
                Err(error) => {
                    failed.push(format!("{}：{}", file.display_path, error.message));
                    continue;
                }
            };
            let current = match fs::read(&path) {
                Ok(bytes) => bytes,
                Err(error) => {
                    failed.push(format!("{}：{}", file.display_path, error));
                    continue;
                }
            };
            if file.after_revision.as_deref() != Some(digest(&current).as_str()) {
                conflicts.push(file.display_path.clone());
                if let Some(stored) = plan.files.get_mut(index) {
                    stored.state = ReplaceFileState::RollbackConflict;
                    stored.reason = Some("当前文件已再次变化；备份保留，未覆盖。".into());
                }
                persist_manifest(&plan_dir, &plan)?;
                continue;
            }
            let before_ref = file
                .before_snapshot_ref
                .as_deref()
                .ok_or_else(plan_invalid)?;
            let before = fs::read(plan_dir.join(before_ref)).map_err(crate::models::io_error)?;
            if digest(&before) != file.before_hash {
                return Err(AppError::new(
                    ErrorCode::Conflict,
                    "计划原始备份校验失败，未回滚。",
                ));
            }
            let expected_current = file.after_revision.as_deref().ok_or_else(plan_invalid)?;
            match replace_source(&path, &before, expected_current) {
                Ok(()) => {
                    if let Some(stored) = plan.files.get_mut(index) {
                        stored.state = ReplaceFileState::RolledBack;
                        stored.reason = Some("已恢复计划前原始字节。".into());
                    }
                    restored.push(file.display_path.clone());
                    persist_manifest(&plan_dir, &plan)?;
                }
                Err(error) => failed.push(format!("{}：{}", file.display_path, error.message)),
            }
        }
        let status = if failed.is_empty() && conflicts.is_empty() {
            "completed"
        } else if restored.is_empty() {
            "failed"
        } else {
            "partial"
        };
        Ok(RollbackBatchOutcome {
            batch_id: plan.plan_id,
            status: status.into(),
            restored,
            conflicts,
            failed,
            rollback_journal_ref: format!("replacement-plans/{}", request.batch_id),
        })
    }

    fn apply_plan_file(&self, plan_dir: &Path, file: &ReplacePlanFile) -> Result<String, AppError> {
        let path = self.grants.resolve_entry(&file.reference)?.path;
        let current = fs::read(&path).map_err(crate::models::io_error)?;
        if digest(&current) != file.before_hash {
            return Err(AppError::new(ErrorCode::Conflict, "文件在写入前再次变化。"));
        }
        let after_ref = file
            .after_snapshot_ref
            .as_deref()
            .ok_or_else(plan_invalid)?;
        let after = fs::read(plan_dir.join(after_ref)).map_err(crate::models::io_error)?;
        if digest(&after) != file.after_hash {
            return Err(AppError::new(ErrorCode::Conflict, "计划替换快照校验失败。"));
        }
        replace_source(&path, &after, &file.before_hash)?;
        Ok(digest(&after))
    }
}

fn validate_plan_request(request: &CreateReplacePlanRequest) -> Result<(), AppError> {
    if request.pattern.is_empty()
        || request.pattern.len() > 10 * 1024
        || request.replacement.len() > 64 * 1024
        || request.roots.is_empty()
        || request.roots.len() > 16
        || request.include.len() > 256
        || request.exclude.len() > 256
        || request.dirty_paths.len() > 10_000
        || request.dirty_paths.iter().any(|path| path.len() > 32_767)
    {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "替换计划的范围、表达式或选择无效。",
        ));
    }
    Ok(())
}

fn prepare_replacement_template(
    replacement: &str,
    is_regex: bool,
    regex: &Regex,
) -> Result<String, AppError> {
    if !is_regex {
        return Ok(replacement.replace('$', "$$"));
    }
    let mut result = String::with_capacity(replacement.len());
    let mut chars = replacement.char_indices().peekable();
    while let Some((index, character)) = chars.next() {
        if character != '$' {
            result.push(character);
            continue;
        }
        let Some((_, next)) = chars.peek().copied() else {
            result.push_str("$$");
            continue;
        };
        if next == '$' {
            chars.next();
            result.push_str("$$");
            continue;
        }
        if next.is_ascii_digit() {
            let mut digits = String::new();
            while let Some((_, digit)) = chars.peek().copied() {
                if !digit.is_ascii_digit() {
                    break;
                }
                chars.next();
                digits.push(digit);
            }
            let group = digits.parse::<usize>().unwrap_or(usize::MAX);
            if group == 0 || group >= regex.captures_len() {
                return Err(AppError::new(
                    ErrorCode::InvalidInput,
                    &format!("替换引用了不存在的捕获组 ${digits}"),
                ));
            }
            result.push('$');
            result.push_str(&digits);
            continue;
        }
        if next == '{' {
            let start = index;
            chars.next();
            let mut name = String::new();
            let mut closed = false;
            for (_, character) in chars.by_ref() {
                if character == '}' {
                    closed = true;
                    break;
                }
                name.push(character);
            }
            if !closed
                || !regex
                    .capture_names()
                    .flatten()
                    .any(|candidate| candidate == name)
            {
                return Err(AppError::new(
                    ErrorCode::InvalidInput,
                    &format!("替换引用了不存在的命名捕获组（位置 {start}）"),
                ));
            }
            result.push_str("${");
            result.push_str(&name);
            result.push('}');
            continue;
        }
        result.push_str("$$");
    }
    Ok(result)
}

fn replace_source(path: &Path, bytes: &[u8], expected_current_hash: &str) -> Result<(), AppError> {
    let _locks = windows_file::lock_parent_chain(path)?;
    let parent = path.parent().ok_or_else(plan_invalid)?;
    let id = uuid::Uuid::new_v4();
    let temporary = parent.join(format!(".featherpad-replace-{id}.tmp"));
    let backup = parent.join(format!(".featherpad-replace-{id}.bak"));
    write_new_verified(&temporary, bytes)?;
    let current = fs::read(path).map_err(crate::models::io_error)?;
    if digest(&current) != expected_current_hash {
        let _ = windows_file::delete_owned_backup(&temporary, &digest(bytes));
        return Err(AppError::new(
            ErrorCode::Conflict,
            "文件在替换临界区发生变化。",
        ));
    }
    if let Err(error) = windows_file::replace(path, &temporary, &backup) {
        let _ = windows_file::delete_owned_backup(&temporary, &digest(bytes));
        return Err(error);
    }
    let after = fs::read(path).map_err(crate::models::io_error)?;
    if digest(&after) != digest(bytes) {
        return Err(AppError::new(
            ErrorCode::IpcUnavailable,
            "替换回执未确认；请通过批次记录核对。",
        ));
    }
    let _ = windows_file::delete_owned_backup(&backup, expected_current_hash);
    Ok(())
}

fn digest(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn reference_key(reference: &FileRef) -> String {
    format!("{}\0{}", reference.grant_id, reference.relative_path)
}

fn plan_directory(root: &Path, plan_id: &str) -> Result<PathBuf, AppError> {
    let parsed = uuid::Uuid::parse_str(plan_id).map_err(|_| plan_invalid())?;
    if parsed.to_string() != plan_id {
        return Err(plan_invalid());
    }
    Ok(root.join(plan_id))
}

fn load_manifest(plan_dir: &Path) -> Result<ReplacementPlan, AppError> {
    let bytes = fs::read(plan_dir.join("manifest.json")).map_err(crate::models::io_error)?;
    if bytes.len() > 8 * 1024 * 1024 {
        return Err(plan_invalid());
    }
    let plan: ReplacementPlan = serde_json::from_slice(&bytes).map_err(|_| plan_invalid())?;
    if plan.schema_version != 1
        || plan_dir.file_name().and_then(|name| name.to_str()) != Some(plan.plan_id.as_str())
    {
        return Err(plan_invalid());
    }
    Ok(plan)
}

fn persist_manifest(plan_dir: &Path, plan: &ReplacementPlan) -> Result<(), AppError> {
    let body = serde_json::to_vec(plan).map_err(|_| plan_invalid())?;
    let target = plan_dir.join("manifest.json");
    let temporary = plan_dir.join(format!(".manifest-{}.tmp", uuid::Uuid::new_v4()));
    write_new_verified(&temporary, &body)?;
    if target.exists() {
        let backup = plan_dir.join("manifest.previous.json");
        if backup.exists() {
            fs::remove_file(&backup).map_err(crate::models::io_error)?;
        }
        windows_file::replace(&target, &temporary, &backup)?;
    } else {
        fs::rename(&temporary, &target).map_err(crate::models::io_error)?;
    }
    Ok(())
}

fn plan_invalid() -> AppError {
    AppError::new(
        ErrorCode::InvalidInput,
        "替换计划或批次记录无效、损坏或已移位。",
    )
}

fn now_millis() -> Result<i64, AppError> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| AppError::new(ErrorCode::Internal, "系统时间无效，替换计划已取消。"))?;
    i64::try_from(elapsed.as_millis()).map_err(|_| {
        AppError::new(
            ErrorCode::Internal,
            "系统时间超出支持范围，替换计划已取消。",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::{grants::GrantKind, walker::WalkCoordinator};
    use std::sync::Arc;

    fn fixture() -> (PathBuf, PathBuf, FileService, FileRef) {
        let scratch = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".artifacts")
            .join("test-scratch");
        fs::create_dir_all(&scratch).unwrap();
        let root = scratch.join(format!(
            "featherpad-replace-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let store = root.join("plans");
        fs::create_dir_all(root.join("workspace")).unwrap();
        fs::create_dir_all(&store).unwrap();
        fs::write(root.join("workspace/a.txt"), "old value\n").unwrap();
        let mut service = FileService::default();
        let grant = service
            .grants
            .register_selection(&root.join("workspace"), GrantKind::Directory)
            .unwrap();
        (root, store, service, grant)
    }

    fn request(root: FileRef) -> CreateReplacePlanRequest {
        CreateReplacePlanRequest {
            request_id: uuid::Uuid::new_v4().to_string(),
            roots: vec![root],
            pattern: "old".into(),
            replacement: "new".into(),
            is_regex: false,
            is_case_sensitive: true,
            is_whole_word: true,
            include: vec!["*.txt".into()],
            exclude: vec![],
            respect_gitignore: false,
            follow_directory_links: false,
            include_hidden: false,
            dirty_paths: vec![],
        }
    }

    #[test]
    fn preview_is_read_only_commit_is_verified_and_rollback_restores_original_bytes() {
        let (root, store, mut service, grant) = fixture();
        let plan = service
            .create_replace_plan(
                request(grant.clone()),
                &store,
                Arc::new(WalkCoordinator::default()),
            )
            .unwrap();
        assert_eq!(plan.files[0].match_lines, vec![1]);
        assert_eq!(plan.files[0].preview_hunks.len(), 1);
        assert_eq!(plan.files[0].preview_hunks[0].start_line, 1);
        assert_eq!(plan.files[0].preview_hunks[0].after_start_line, 1);
        assert_eq!(plan.files[0].preview_hunks[0].before, vec!["old value"]);
        assert_eq!(plan.files[0].preview_hunks[0].after, vec!["new value"]);
        assert_eq!(plan.files[0].preview_hunks[0].match_lines, vec![1]);
        assert_eq!(
            fs::read_to_string(root.join("workspace/a.txt")).unwrap(),
            "old value\n"
        );
        let outcome = service
            .commit_replace_plan(
                CommitReplacePlanRequest {
                    plan_id: plan.plan_id.clone(),
                    confirmation_token: plan.confirmation_token.clone(),
                    selected: vec![FileRef {
                        grant_id: grant.grant_id.clone(),
                        relative_path: "a.txt".into(),
                    }],
                },
                &store,
            )
            .unwrap();
        assert_eq!(outcome.status, "completed");
        assert_eq!(
            fs::read_to_string(root.join("workspace/a.txt")).unwrap(),
            "new value\n"
        );
        let rollback = service
            .rollback_replace_batch(
                RollbackReplaceBatchRequest {
                    batch_id: plan.plan_id,
                },
                &store,
            )
            .unwrap();
        assert_eq!(rollback.status, "completed");
        assert_eq!(
            fs::read_to_string(root.join("workspace/a.txt")).unwrap(),
            "old value\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn external_change_blocks_commit_and_later_edit_blocks_rollback() {
        let (root, store, mut service, grant) = fixture();
        let plan = service
            .create_replace_plan(
                request(grant.clone()),
                &store,
                Arc::new(WalkCoordinator::default()),
            )
            .unwrap();
        fs::write(root.join("workspace/a.txt"), "external\n").unwrap();
        assert!(service
            .commit_replace_plan(
                CommitReplacePlanRequest {
                    plan_id: plan.plan_id.clone(),
                    confirmation_token: plan.confirmation_token.clone(),
                    selected: vec![FileRef {
                        grant_id: grant.grant_id.clone(),
                        relative_path: "a.txt".into(),
                    }],
                },
                &store,
            )
            .is_err());
        assert_eq!(
            fs::read_to_string(root.join("workspace/a.txt")).unwrap(),
            "external\n"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn edit_after_commit_blocks_rollback_and_preserves_new_content() {
        let (root, store, mut service, grant) = fixture();
        let plan = service
            .create_replace_plan(
                request(grant.clone()),
                &store,
                Arc::new(WalkCoordinator::default()),
            )
            .unwrap();
        let outcome = service
            .commit_replace_plan(
                CommitReplacePlanRequest {
                    plan_id: plan.plan_id.clone(),
                    confirmation_token: plan.confirmation_token.clone(),
                    selected: vec![FileRef {
                        grant_id: grant.grant_id,
                        relative_path: "a.txt".into(),
                    }],
                },
                &store,
            )
            .unwrap();
        assert_eq!(outcome.status, "completed");
        fs::write(root.join("workspace/a.txt"), "edited after commit\n").unwrap();

        let rollback = service
            .rollback_replace_batch(
                RollbackReplaceBatchRequest {
                    batch_id: plan.plan_id.clone(),
                },
                &store,
            )
            .unwrap();

        assert_eq!(rollback.status, "failed");
        assert_eq!(rollback.restored.len(), 0);
        assert_eq!(rollback.conflicts.len(), 1);
        assert_eq!(
            fs::read_to_string(root.join("workspace/a.txt")).unwrap(),
            "edited after commit\n"
        );
        let manifest = load_manifest(&store.join(&plan.plan_id)).unwrap();
        assert_eq!(manifest.files[0].state, ReplaceFileState::RollbackConflict);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn commit_preserves_utf16_encoding_bom_and_original_newlines() {
        let (root, store, mut service, grant) = fixture();
        let path = root.join("workspace/a.txt");
        fs::write(
            &path,
            encode_text("old value\r\n中文", "utf-16le", "utf16le").unwrap(),
        )
        .unwrap();
        let plan = service
            .create_replace_plan(
                request(grant.clone()),
                &store,
                Arc::new(WalkCoordinator::default()),
            )
            .unwrap();
        assert_eq!(plan.files[0].encoding, "utf-16le");
        let outcome = service
            .commit_replace_plan(
                CommitReplacePlanRequest {
                    plan_id: plan.plan_id,
                    confirmation_token: plan.confirmation_token,
                    selected: vec![FileRef {
                        grant_id: grant.grant_id,
                        relative_path: "a.txt".into(),
                    }],
                },
                &store,
            )
            .unwrap();
        assert_eq!(outcome.status, "completed");
        let saved = fs::read(path).unwrap();
        assert!(saved.starts_with(&[0xff, 0xfe]));
        assert_eq!(decode_basic(&saved).unwrap().text, "new value\r\n中文");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preview_reports_match_lines_and_context() {
        let (root, store, service, grant) = fixture();
        fs::write(
            root.join("workspace/a.txt"),
            "first\nold one\nthird\nold two\nfifth\n",
        )
        .unwrap();
        let plan = service
            .create_replace_plan(request(grant), &store, Arc::new(WalkCoordinator::default()))
            .unwrap();
        let file = &plan.files[0];
        assert_eq!(file.match_lines, vec![2, 4]);
        assert_eq!(file.preview_hunks.len(), 1);
        let hunk = &file.preview_hunks[0];
        assert_eq!(hunk.start_line, 1);
        assert_eq!(hunk.after_start_line, 1);
        assert_eq!(
            hunk.before,
            vec!["first", "old one", "third", "old two", "fifth"]
        );
        assert_eq!(
            hunk.after,
            vec!["first", "new one", "third", "new two", "fifth"]
        );
        assert_eq!(hunk.match_lines, vec![2, 4]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preview_after_line_numbers_follow_inserted_lines() {
        let (root, store, service, grant) = fixture();
        fs::write(
            root.join("workspace/a.txt"),
            "old a\nx\nx\nx\nx\nx\nold b\n",
        )
        .unwrap();
        let mut replace_request = request(grant);
        replace_request.replacement = "new\nextra".into();
        let plan = service
            .create_replace_plan(
                replace_request,
                &store,
                Arc::new(WalkCoordinator::default()),
            )
            .unwrap();
        let file = &plan.files[0];
        assert_eq!(file.match_lines, vec![1, 7]);
        assert_eq!(file.preview_hunks.len(), 2);
        assert_eq!(file.preview_hunks[0].after_start_line, 1);
        assert_eq!(file.preview_hunks[1].start_line, 5);
        assert_eq!(file.preview_hunks[1].after_start_line, 6);
        assert_eq!(file.preview_hunks[1].after[0], "x");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preview_handles_crlf_line_numbers() {
        let (root, store, service, grant) = fixture();
        fs::write(root.join("workspace/a.txt"), "first\r\nold\r\nthird\r\n").unwrap();
        let plan = service
            .create_replace_plan(request(grant), &store, Arc::new(WalkCoordinator::default()))
            .unwrap();
        let file = &plan.files[0];
        assert_eq!(file.match_lines, vec![2]);
        assert_eq!(file.preview_hunks[0].before, vec!["first", "old", "third"]);
        assert_eq!(file.preview_hunks[0].after, vec!["first", "new", "third"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn file_over_match_limit_is_reported_as_incomplete_instead_of_partially_replaced() {
        let (root, store, service, grant) = fixture();
        let path = root.join("workspace/a.txt");
        fs::write(&path, vec!["old"; 1_001].join(" ")).unwrap();
        let plan = service
            .create_replace_plan(request(grant), &store, Arc::new(WalkCoordinator::default()))
            .unwrap();
        assert!(plan.files.is_empty());
        assert!(plan.truncated);
        assert!(plan
            .skipped
            .iter()
            .any(|reason| reason.contains("1000上限")));
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            vec!["old"; 1_001].join(" ")
        );
        fs::remove_dir_all(root).unwrap();
    }
}
