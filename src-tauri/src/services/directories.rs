use super::files::FileService;
use crate::models::{
    io_error, AppError, DirectoryEntry, DirectoryPage, ErrorCode, FileRef, ListDirectoryRequest,
};
use sha2::{Digest, Sha256};
#[cfg(not(windows))]
use std::fs;
use std::{
    collections::{HashMap, VecDeque},
    fs::Metadata,
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};
#[cfg(windows)]
use std::{
    ffi::{c_void, OsString},
    os::windows::ffi::{OsStrExt, OsStringExt},
    ptr,
};

const DEFAULT_PAGE_SIZE: u32 = 200;
const MAX_PAGE_SIZE: u32 = 1000;
const MAX_CURSORS: usize = 2048;

#[derive(Clone)]
struct CursorState {
    directory: String,
    revision: String,
    show_hidden: bool,
    offset: usize,
}

#[derive(Default)]
pub struct DirectoryCursors {
    states: HashMap<String, CursorState>,
    order: VecDeque<String>,
}

impl DirectoryCursors {
    fn issue(
        &mut self,
        directory: String,
        revision: String,
        show_hidden: bool,
        offset: usize,
    ) -> String {
        let token = uuid::Uuid::new_v4().to_string();
        self.states.insert(
            token.clone(),
            CursorState {
                directory,
                revision,
                show_hidden,
                offset,
            },
        );
        self.order.push_back(token.clone());
        while self.order.len() > MAX_CURSORS {
            if let Some(expired) = self.order.pop_front() {
                self.states.remove(&expired);
            }
        }
        token
    }

    fn resolve(&self, token: &str) -> Option<&CursorState> {
        self.states.get(token)
    }
}

impl FileService {
    pub fn list_directory(
        &mut self,
        request: ListDirectoryRequest,
    ) -> Result<DirectoryPage, AppError> {
        let limit = request.limit.unwrap_or(DEFAULT_PAGE_SIZE);
        if limit == 0 || limit > MAX_PAGE_SIZE {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "目录分页大小必须在1到1000之间。",
            ));
        }
        if request
            .cursor
            .as_ref()
            .is_some_and(|cursor| cursor.len() != 36)
        {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "目录分页游标无效，请刷新目录。",
            ));
        }

        let directory = self.grants.resolve_directory(&request.reference)?;
        // Keep every path component non-renamable while the enumeration opens its own handles.
        let _parents = super::windows_file::lock_parent_chain(&directory)?;
        let _directory = super::windows_file::lock_directory(&directory)?;
        let directory_key = format!(
            "{}\0{}",
            request.reference.grant_id,
            directory.to_string_lossy()
        );
        let cursor_state = match request.cursor {
            Some(cursor) => {
                let state = self
                    .directory_cursors
                    .resolve(&cursor)
                    .ok_or_else(invalid_cursor)?;
                if state.directory != directory_key || state.show_hidden != request.show_hidden {
                    return Err(AppError::new(
                        ErrorCode::Conflict,
                        "目录内容或显示设置已变化，请刷新后重试。",
                    ));
                }
                Some((state.revision.clone(), state.offset))
            }
            None => None,
        };

        let mut entries = read_entries(&request.reference, &directory)?;
        if !request.show_hidden {
            entries.retain(|entry| !entry.is_hidden);
        }
        sort_directory_entries(&mut entries);
        let revision = entries_revision(&entries);
        if cursor_state
            .as_ref()
            .is_some_and(|(cursor_revision, _)| cursor_revision != &revision)
        {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "目录内容或显示设置已变化，请刷新后重试。",
            ));
        }
        let offset = cursor_state.map_or(0, |(_, offset)| offset);
        if offset > entries.len() {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "目录分页位置已失效，请刷新后重试。",
            ));
        }
        let end = offset.saturating_add(limit as usize).min(entries.len());
        let next_cursor = (end < entries.len()).then(|| {
            self.directory_cursors
                .issue(directory_key, revision, request.show_hidden, end)
        });
        Ok(DirectoryPage {
            items: entries.drain(offset..end).collect(),
            next_cursor,
        })
    }
}

#[cfg(windows)]
fn read_entries(root: &FileRef, directory: &Path) -> Result<Vec<DirectoryEntry>, AppError> {
    use windows_sys::Win32::{
        Foundation::{
            GetLastError, ERROR_INVALID_PARAMETER, ERROR_NO_MORE_FILES, HANDLE,
            INVALID_HANDLE_VALUE,
        },
        Storage::FileSystem::{
            FindClose, FindExInfoBasic, FindExInfoStandard, FindExSearchNameMatch,
            FindFirstFileExW, FindNextFileW, FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_HIDDEN,
            FILE_ATTRIBUTE_READONLY, FILE_ATTRIBUTE_REPARSE_POINT, FIND_FIRST_EX_LARGE_FETCH,
            WIN32_FIND_DATAW,
        },
    };

    struct FindHandle(HANDLE);
    impl Drop for FindHandle {
        fn drop(&mut self) {
            unsafe {
                FindClose(self.0);
            }
        }
    }

    fn find_first(pattern: &[u16], info_level: i32, flags: u32) -> (HANDLE, WIN32_FIND_DATAW) {
        let mut data = WIN32_FIND_DATAW::default();
        let handle = unsafe {
            FindFirstFileExW(
                pattern.as_ptr(),
                info_level,
                (&raw mut data).cast::<c_void>(),
                FindExSearchNameMatch,
                ptr::null(),
                flags,
            )
        };
        (handle, data)
    }

    let mut pattern = directory
        .join("*")
        .as_os_str()
        .encode_wide()
        .collect::<Vec<_>>();
    pattern.push(0);
    let (mut handle, mut data) = find_first(&pattern, FindExInfoBasic, FIND_FIRST_EX_LARGE_FETCH);
    if handle == INVALID_HANDLE_VALUE && unsafe { GetLastError() } == ERROR_INVALID_PARAMETER {
        (handle, data) = find_first(&pattern, FindExInfoStandard, 0);
    }
    if handle == INVALID_HANDLE_VALUE {
        return Err(io_error(std::io::Error::last_os_error()));
    }
    let handle = FindHandle(handle);

    let mut output = Vec::new();
    loop {
        let name_length = data
            .cFileName
            .iter()
            .position(|character| *character == 0)
            .unwrap_or(data.cFileName.len());
        let wide_name = &data.cFileName[..name_length];
        if wide_name != [b'.' as u16] && wide_name != [b'.' as u16, b'.' as u16] {
            let name = OsString::from_wide(wide_name).into_string().map_err(|_| {
                AppError::new(
                    ErrorCode::Unsupported,
                    "目录中含无法无损显示的Windows文件名，已停止分页。",
                )
            })?;
            let attributes = data.dwFileAttributes;
            let kind = if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
                if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
                    "junction"
                } else {
                    "symlink"
                }
            } else if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
                "directory"
            } else {
                "file"
            };
            // NTFS enumeration can retain an old directory last-write timestamp
            // after child changes. Destructive operations validate fresh metadata,
            // so issue directory tickets from the same source. Flat file listings
            // keep the bounded FindFirstFileEx fast path.
            let (revision, modified_at, created_at) = if kind == "directory" {
                let metadata =
                    std::fs::symlink_metadata(directory.join(&name)).map_err(io_error)?;
                let timestamps = metadata_timestamps(&metadata);
                (
                    revision_from_metadata(&name, kind, &metadata)?,
                    timestamps.0,
                    timestamps.1,
                )
            } else {
                (
                    revision_from_windows_fields(
                        &data,
                        kind,
                        revision_size(
                            kind,
                            ((data.nFileSizeHigh as u64) << 32) | data.nFileSizeLow as u64,
                        ),
                    ),
                    filetime_timestamp(&data.ftLastWriteTime),
                    filetime_timestamp(&data.ftCreationTime),
                )
            };
            output.push(directory_entry(
                root,
                name,
                kind,
                attributes & FILE_ATTRIBUTE_HIDDEN != 0,
                attributes & FILE_ATTRIBUTE_READONLY != 0,
                revision,
                modified_at,
                created_at,
            ));
        }
        if unsafe { FindNextFileW(handle.0, &raw mut data) } == 0 {
            let error = unsafe { GetLastError() };
            if error == ERROR_NO_MORE_FILES {
                break;
            }
            return Err(io_error(std::io::Error::from_raw_os_error(error as i32)));
        }
    }
    Ok(output)
}

#[cfg(not(windows))]
fn read_entries(root: &FileRef, directory: &Path) -> Result<Vec<DirectoryEntry>, AppError> {
    let mut output = Vec::new();
    for entry in fs::read_dir(directory).map_err(io_error)? {
        let entry = entry.map_err(io_error)?;
        let name = entry.file_name().into_string().map_err(|_| {
            AppError::new(
                ErrorCode::Unsupported,
                "目录中含无法无损显示的Windows文件名，已停止分页。",
            )
        })?;
        let path = entry.path();
        let metadata = fs::symlink_metadata(&path).map_err(io_error)?;
        let hidden = is_hidden(&metadata);
        let target_is_directory = if metadata.file_type().is_symlink() {
            path.metadata()
                .map(|target| target.is_dir())
                .unwrap_or(false)
        } else {
            metadata.is_dir()
        };
        let kind = entry_kind(&metadata, target_is_directory);
        let revision = revision_from_metadata_with_size(
            &name,
            kind,
            &metadata,
            revision_size(kind, metadata.len()),
        )?;
        let timestamps = metadata_timestamps(&metadata);
        output.push(directory_entry(
            root,
            name,
            kind,
            hidden,
            is_read_only(&metadata),
            revision,
            timestamps.0,
            timestamps.1,
        ));
    }
    Ok(output)
}

fn directory_entry(
    root: &FileRef,
    name: String,
    kind: &'static str,
    is_hidden: bool,
    is_read_only: bool,
    revision: String,
    modified_at: Option<String>,
    created_at: Option<String>,
) -> DirectoryEntry {
    let relative_path = relative_path(root, &name);
    DirectoryEntry {
        id: entry_id(&root.grant_id, &relative_path),
        reference: FileRef {
            grant_id: root.grant_id.clone(),
            relative_path,
        },
        name,
        kind,
        is_hidden,
        is_read_only,
        revision,
        modified_at,
        created_at,
    }
}

fn timestamp_from_seconds(seconds: u64, nanos: u32) -> Option<String> {
    chrono::DateTime::<chrono::Utc>::from_timestamp(i64::try_from(seconds).ok()?, nanos)
        .map(|value| value.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true))
}

pub(super) fn metadata_timestamps(metadata: &Metadata) -> (Option<String>, Option<String>) {
    let convert = |value: Result<SystemTime, std::io::Error>| -> Option<String> {
        let elapsed = value.ok()?.duration_since(UNIX_EPOCH).ok()?;
        timestamp_from_seconds(elapsed.as_secs(), elapsed.subsec_nanos())
    };
    (convert(metadata.modified()), convert(metadata.created()))
}

#[cfg(windows)]
fn filetime_timestamp(value: &windows_sys::Win32::Foundation::FILETIME) -> Option<String> {
    const FILETIME_UNIX_EPOCH: u64 = 116_444_736_000_000_000;
    let ticks = ((value.dwHighDateTime as u64) << 32) | value.dwLowDateTime as u64;
    let elapsed = ticks.checked_sub(FILETIME_UNIX_EPOCH)?;
    timestamp_from_seconds(elapsed / 10_000_000, ((elapsed % 10_000_000) as u32) * 100)
}

#[cfg(windows)]
fn revision_from_windows_fields(
    data: &windows_sys::Win32::Storage::FileSystem::WIN32_FIND_DATAW,
    kind: &str,
    size: u64,
) -> String {
    let name_length = data
        .cFileName
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(data.cFileName.len());
    let name = String::from_utf16_lossy(&data.cFileName[..name_length]);
    revision_from_parts(
        &name,
        kind,
        data.dwFileAttributes,
        size,
        ((data.ftLastWriteTime.dwHighDateTime as u64) << 32)
            | data.ftLastWriteTime.dwLowDateTime as u64,
    )
}

#[cfg(windows)]
pub(super) fn revision_from_metadata(
    name: &str,
    kind: &str,
    metadata: &Metadata,
) -> Result<String, AppError> {
    revision_from_metadata_with_size(name, kind, metadata, revision_size(kind, metadata.len()))
}

#[cfg(windows)]
fn revision_from_metadata_with_size(
    name: &str,
    kind: &str,
    metadata: &Metadata,
    size: u64,
) -> Result<String, AppError> {
    use std::os::windows::fs::MetadataExt;
    Ok(revision_from_parts(
        name,
        kind,
        metadata.file_attributes(),
        size,
        metadata.last_write_time(),
    ))
}

#[cfg(not(windows))]
fn revision_from_metadata_with_size(
    name: &str,
    kind: &str,
    metadata: &Metadata,
    size: u64,
) -> Result<String, AppError> {
    let attributes = match (
        metadata.is_dir(),
        is_hidden(metadata),
        is_read_only(metadata),
    ) {
        (true, true, true) => 7u32,
        (true, true, false) => 6,
        (true, false, true) => 5,
        (true, false, false) => 4,
        (false, true, true) => 3,
        (false, true, false) => 2,
        (false, false, true) => 1,
        (false, false, false) => 0,
    };
    let modified = metadata
        .modified()
        .map_err(io_error)?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| AppError::new(ErrorCode::Conflict, "文件时间戳无效，请刷新后重试。"))?
        .as_nanos()
        .min(u128::from(u64::MAX)) as u64;
    Ok(revision_from_parts(name, kind, attributes, size, modified))
}

fn revision_size(kind: &str, file_size: u64) -> u64 {
    if kind == "file" {
        file_size
    } else {
        0
    }
}

fn revision_from_parts(
    name: &str,
    kind: &str,
    attributes: u32,
    size: u64,
    last_write: u64,
) -> String {
    let mut hash = Sha256::new();
    hash.update((name.len() as u64).to_le_bytes());
    hash.update(name.as_bytes());
    hash.update((kind.len() as u64).to_le_bytes());
    hash.update(kind.as_bytes());
    hash.update(attributes.to_le_bytes());
    hash.update(size.to_le_bytes());
    hash.update(last_write.to_le_bytes());
    format!("{:x}", hash.finalize())
}

fn relative_path(root: &FileRef, name: &str) -> String {
    if root.relative_path.is_empty() {
        name.to_owned()
    } else {
        format!(
            "{}/{}",
            root.relative_path.trim_end_matches(['/', '\\']),
            name
        )
    }
}

pub(super) fn entry_id(grant_id: &str, relative_path: &str) -> String {
    let mut hash = Sha256::new();
    hash.update(grant_id.as_bytes());
    hash.update([0]);
    hash.update(relative_path.as_bytes());
    format!("{:x}", hash.finalize())
}

fn entries_revision(entries: &[DirectoryEntry]) -> String {
    let mut hash = Sha256::new();
    for entry in entries {
        hash.update((entry.kind.len() as u64).to_le_bytes());
        hash.update(entry.kind.as_bytes());
        hash.update([u8::from(entry.is_hidden), u8::from(entry.is_read_only)]);
        hash.update((entry.name.len() as u64).to_le_bytes());
        hash.update(entry.name.as_bytes());
    }
    format!("{:x}", hash.finalize())
}

fn sort_directory_entries(entries: &mut [DirectoryEntry]) {
    entries.sort_by_cached_key(|entry| {
        (
            entry.kind != "directory",
            NaturalSortKey::new(&entry.name),
            entry.name.clone(),
        )
    });
}

#[cfg(not(windows))]
fn entry_kind(metadata: &Metadata, target_is_directory: bool) -> &'static str {
    if is_reparse(metadata) && target_is_directory {
        "junction"
    } else if metadata.file_type().is_symlink() || is_reparse(metadata) {
        "symlink"
    } else if metadata.is_dir() {
        "directory"
    } else {
        "file"
    }
}

#[cfg(not(windows))]
fn is_hidden(metadata: &Metadata) -> bool {
    metadata
        .file_name()
        .to_str()
        .is_some_and(|name| name.starts_with('.'))
}

#[cfg(not(windows))]
fn is_read_only(metadata: &Metadata) -> bool {
    metadata.permissions().readonly()
}

#[cfg(not(windows))]
fn is_reparse(metadata: &Metadata) -> bool {
    metadata.file_type().is_symlink()
}

#[derive(Clone, Eq, PartialEq)]
struct NaturalSortKey(Vec<(bool, String)>);

impl NaturalSortKey {
    fn new(name: &str) -> Self {
        let mut output: Vec<(bool, String)> = Vec::new();
        let mut current = String::new();
        let mut current_numeric = false;
        for character in name.chars().flat_map(char::to_lowercase) {
            let numeric = character.is_ascii_digit();
            if !current.is_empty() && numeric != current_numeric {
                output.push((current_numeric, std::mem::take(&mut current)));
            }
            current_numeric = numeric;
            current.push(character);
        }
        if !current.is_empty() {
            output.push((current_numeric, current));
        }
        Self(output)
    }
}

impl Ord for NaturalSortKey {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        for (left, right) in self.0.iter().zip(&other.0) {
            let ordering = match (left, right) {
                ((true, left), (true, right)) => {
                    let left_value = left.trim_start_matches('0');
                    let right_value = right.trim_start_matches('0');
                    let left_value = if left_value.is_empty() {
                        "0"
                    } else {
                        left_value
                    };
                    let right_value = if right_value.is_empty() {
                        "0"
                    } else {
                        right_value
                    };
                    left_value
                        .len()
                        .cmp(&right_value.len())
                        .then_with(|| left_value.cmp(right_value))
                        .then_with(|| left.len().cmp(&right.len()))
                }
                ((false, left), (false, right)) => left.cmp(right),
                ((true, _), (false, _)) => std::cmp::Ordering::Less,
                ((false, _), (true, _)) => std::cmp::Ordering::Greater,
            };
            if ordering != std::cmp::Ordering::Equal {
                return ordering;
            }
        }
        self.0.len().cmp(&other.0.len())
    }
}

impl PartialOrd for NaturalSortKey {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

fn invalid_cursor() -> AppError {
    AppError::new(
        ErrorCode::InvalidInput,
        "目录分页游标无效或已过期，请刷新后重试。",
    )
}

#[cfg(test)]
mod tests {
    use super::NaturalSortKey;

    #[test]
    fn natural_sort_orders_numeric_runs_without_lexical_name_eleven() {
        let mut names = vec![
            "file10.txt".to_owned(),
            "file2.txt".to_owned(),
            "file02.txt".to_owned(),
            "File1.txt".to_owned(),
        ];
        names.sort_by_cached_key(|name| NaturalSortKey::new(name));
        assert_eq!(
            names,
            ["File1.txt", "file2.txt", "file02.txt", "file10.txt"]
        );
    }
}
