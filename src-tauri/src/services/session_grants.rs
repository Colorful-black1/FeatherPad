use super::{
    grants::{GrantRegistry, PersistedGrant},
    save_journal::{digest, write_new_verified},
    windows_file,
};
use crate::models::{io_error, AppError, ErrorCode};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
};

const MAX_GRANT_STORE_BYTES: u64 = 4 * 1024 * 1024;
const MAX_PERSISTED_GRANTS: usize = 4096;

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GrantFile {
    schema_version: u32,
    grants: Vec<PersistedGrant>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    revoked_grant_ids: Vec<String>,
}

struct LoadedGrantFile {
    file: Option<GrantFile>,
    corrupt: bool,
}

pub(crate) struct SessionGrantLoad {
    pub grants: Vec<PersistedGrant>,
    pub warning: Option<String>,
}

pub(crate) struct SessionGrantStore {
    root: PathBuf,
}

impl SessionGrantStore {
    pub(crate) fn new(root: PathBuf) -> Self {
        Self { root }
    }

    pub(crate) fn resolve_required(
        &self,
        current: &GrantRegistry,
        required: &HashSet<String>,
    ) -> Result<Vec<PersistedGrant>, AppError> {
        let mut records = required
            .iter()
            .filter_map(|id| current.persistent_grant(id))
            .collect::<Vec<_>>();
        let missing = required
            .iter()
            .filter(|id| !records.iter().any(|record| &record.grant_id == *id))
            .cloned()
            .collect::<HashSet<_>>();
        if !missing.is_empty() {
            // Retain an existing unavailable source as metadata, without granting access to it.
            let retained = self.load_for(&missing)?;
            if retained.grants.len() != missing.len() {
                return Err(AppError::new(
                    ErrorCode::SessionIncomplete,
                    "会话引用的文件授权不存在，请重新选择或移除相关会话占位。",
                ));
            }
            records.extend(retained.grants);
        }
        Ok(records)
    }

    pub(crate) fn load_for(
        &self,
        required: &HashSet<String>,
    ) -> Result<SessionGrantLoad, AppError> {
        let loaded = self.load_file()?;
        let Some(file) = loaded.file else {
            return Ok(SessionGrantLoad {
                grants: Vec::new(),
                warning: loaded.corrupt.then(|| {
                    "会话授权记录损坏，已隔离并保留原文件；相关文件和工作区需要重新选择。".into()
                }),
            });
        };
        Ok(SessionGrantLoad {
            grants: file
                .grants
                .into_iter()
                .filter(|grant| required.contains(&grant.grant_id))
                .collect(),
            warning: loaded
                .corrupt
                .then(|| "会话授权记录损坏，已隔离并保留原文件。".into()),
        })
    }

    pub(crate) fn save_merged(&self, grants: &[PersistedGrant]) -> Result<(), AppError> {
        self.save_with_revocations(grants, &[])
    }

    pub(crate) fn save_with_revocations(
        &self,
        grants: &[PersistedGrant],
        revoke: &[String],
    ) -> Result<(), AppError> {
        self.ensure_root()?;
        let root = self.root.canonicalize().map_err(io_error)?;
        let target = root.join("grants.json");
        let _parents = windows_file::lock_parent_chain(&target)?;
        let _lock = store_guard(&root)?;
        let previous = self.load_file_locked(&root)?.file.unwrap_or_default();
        let mut revoked = previous
            .revoked_grant_ids
            .into_iter()
            .collect::<HashSet<_>>();
        revoked.extend(revoke.iter().cloned());
        if revoked.len() > MAX_PERSISTED_GRANTS {
            return Err(invalid());
        }
        let mut merged = previous
            .grants
            .into_iter()
            .filter(|grant| !revoked.contains(&grant.grant_id))
            .map(|grant| (grant.grant_id.clone(), grant))
            .collect::<HashMap<_, _>>();
        for grant in grants {
            if !revoked.contains(&grant.grant_id) {
                merged.insert(grant.grant_id.clone(), grant.clone());
            }
        }
        if merged.len() > MAX_PERSISTED_GRANTS {
            return Err(AppError::new(
                ErrorCode::TooLarge,
                "会话授权记录超过上限，请清理旧会话后重试。",
            ));
        }
        let mut values = merged.into_values().collect::<Vec<_>>();
        values.sort_by(|left, right| left.grant_id.cmp(&right.grant_id));
        let mut revoked_grant_ids = revoked.into_iter().collect::<Vec<_>>();
        revoked_grant_ids.sort();
        let bytes = serde_json::to_vec(&GrantFile {
            schema_version: 1,
            grants: values,
            revoked_grant_ids,
        })
        .map_err(|_| invalid())?;
        if bytes.len() as u64 > MAX_GRANT_STORE_BYTES {
            return Err(AppError::new(
                ErrorCode::TooLarge,
                "会话授权记录超过存储上限。",
            ));
        }
        let nonce = uuid::Uuid::new_v4();
        let temporary = root.join(format!("grants-{nonce}.tmp"));
        let backup = root.join(format!("grants-{nonce}.bak"));
        write_new_verified(&temporary, &bytes)?;
        let existing_digest = match fs::symlink_metadata(&target) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(io_error(error)),
            Ok(_) => Some(digest(&read_bounded(&target, MAX_GRANT_STORE_BYTES)?)),
        };
        match existing_digest.as_ref() {
            None => windows_file::move_no_replace(
                &temporary,
                &target,
                "会话授权记录在保存期间出现，已停止覆盖。",
            )?,
            Some(_) => windows_file::replace(&target, &temporary, &backup)?,
        }
        if read_bounded(&target, MAX_GRANT_STORE_BYTES)? != bytes {
            return Err(AppError::new(
                ErrorCode::Conflict,
                "会话授权记录写入后校验失败，旧备份仍保留。",
            ));
        }
        if let Some(expected_hash) = existing_digest {
            let _ = windows_file::delete_owned_backup(&backup, &expected_hash);
        }
        Ok(())
    }

    fn load_file(&self) -> Result<LoadedGrantFile, AppError> {
        match fs::symlink_metadata(&self.root) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Ok(LoadedGrantFile {
                    file: None,
                    corrupt: false,
                })
            }
            Err(error) => return Err(io_error(error)),
            Ok(metadata) if !metadata.is_dir() => return Err(invalid()),
            Ok(_) => {}
        }
        reject_reparse_chain(&self.root)?;
        let root = self.root.canonicalize().map_err(io_error)?;
        let target = root.join("grants.json");
        let _parents = windows_file::lock_parent_chain(&target)?;
        let _lock = store_guard(&root)?;
        self.load_file_locked(&root)
    }

    fn load_file_locked(&self, root: &Path) -> Result<LoadedGrantFile, AppError> {
        let target = root.join("grants.json");
        let bytes = match read_bounded(&target, MAX_GRANT_STORE_BYTES) {
            Ok(bytes) => bytes,
            Err(error) if error.code == ErrorCode::NotFound => {
                return Ok(LoadedGrantFile {
                    file: None,
                    corrupt: false,
                })
            }
            Err(error) => return Err(error),
        };
        let file = match serde_json::from_slice::<GrantFile>(&bytes)
            .map_err(|_| invalid())
            .and_then(validate_file)
        {
            Ok(file) => file,
            Err(_) => {
                let corrupt = root.join(format!("grants.corrupt-{}.json", uuid::Uuid::new_v4()));
                fs::rename(&target, &corrupt).map_err(io_error)?;
                return Ok(LoadedGrantFile {
                    file: None,
                    corrupt: true,
                });
            }
        };
        Ok(LoadedGrantFile {
            file: Some(file),
            corrupt: false,
        })
    }

    fn ensure_root(&self) -> Result<(), AppError> {
        if !self.root.is_absolute() {
            return Err(invalid());
        }
        reject_reparse_chain(&self.root)?;
        fs::create_dir_all(&self.root).map_err(io_error)?;
        reject_reparse_chain(&self.root)
    }
}

fn validate_file(file: GrantFile) -> Result<GrantFile, AppError> {
    if file.schema_version != 1
        || file.grants.len() > MAX_PERSISTED_GRANTS
        || file.revoked_grant_ids.len() > MAX_PERSISTED_GRANTS
    {
        return Err(invalid());
    }
    let mut ids = HashSet::new();
    for id in &file.revoked_grant_ids {
        if uuid::Uuid::parse_str(id)
            .ok()
            .map(|value| value.to_string())
            .as_deref()
            != Some(id.as_str())
            || !ids.insert(id.clone())
        {
            return Err(invalid());
        }
    }
    for grant in &file.grants {
        if uuid::Uuid::parse_str(&grant.grant_id)
            .ok()
            .map(|id| id.to_string())
            .as_deref()
            != Some(grant.grant_id.as_str())
            || !ids.insert(grant.grant_id.clone())
            || grant.path_utf16.is_empty()
            || grant.path_utf16.len() > 32_767
            || grant.path_utf16.contains(&0)
            || grant.identity_sha256.len() != 64
            || !grant
                .identity_sha256
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(invalid());
        }
    }
    Ok(file)
}

fn store_guard(root: &Path) -> Result<std::fs::File, AppError> {
    let path = root.join(".session-grants.lock");
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use windows_sys::Win32::Storage::FileSystem::{
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_READ, FILE_SHARE_WRITE,
        };
        options
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(&path).map_err(io_error)?;
    reject_reparse_chain(&path)?;
    if super::grants::opened_file_path(&file)? != path {
        return Err(invalid());
    }
    file.try_lock()
        .map_err(|_| AppError::new(ErrorCode::Busy, "会话授权记录正在写入，请等待后重试。"))?;
    Ok(file)
}

fn reject_reparse_chain(path: &Path) -> Result<(), AppError> {
    for ancestor in path.ancestors() {
        match fs::symlink_metadata(ancestor) {
            Ok(metadata) => {
                #[cfg(windows)]
                {
                    use std::os::windows::fs::MetadataExt;
                    if metadata.file_attributes()
                        & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
                        != 0
                    {
                        return Err(AppError::new(
                            ErrorCode::OutOfScope,
                            "会话授权目录包含链接，已停止访问。",
                        ));
                    }
                }
                if metadata.file_type().is_symlink() {
                    return Err(invalid());
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_error(error)),
        }
    }
    Ok(())
}

fn read_bounded(path: &Path, max_bytes: u64) -> Result<Vec<u8>, AppError> {
    reject_reparse_chain(path)?;
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(io_error)?;
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if file.metadata().map_err(io_error)?.file_attributes()
            & windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_REPARSE_POINT
            != 0
            || super::grants::opened_file_path(&file)? != path
        {
            return Err(invalid());
        }
    }
    if file.metadata().map_err(io_error)?.len() > max_bytes {
        return Err(invalid());
    }
    let mut bytes = Vec::new();
    file.take(max_bytes + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > max_bytes {
        return Err(invalid());
    }
    Ok(bytes)
}

fn invalid() -> AppError {
    AppError::new(ErrorCode::InvalidInput, "会话授权记录格式无效。")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::grants::{GrantKind, GrantRegistry};
    use std::io::Write;

    fn fixture() -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".artifacts")
            .join("T110")
            .join(format!("session-grants-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    #[test]
    fn persisted_grants_restore_only_the_same_file_and_directory_identity() {
        let root = fixture();
        let file = root.join("fixture.txt");
        let directory = root.join("folder");
        fs::create_dir(&directory).unwrap();
        let mut writer = fs::File::create(&file).unwrap();
        writer.write_all(b"fixture").unwrap();
        drop(writer);

        let mut original = GrantRegistry::default();
        let file_ref = original.register_selection(&file, GrantKind::File).unwrap();
        let directory_ref = original
            .register_selection(&directory, GrantKind::Directory)
            .unwrap();
        let records = vec![
            original.persistent_grant(&file_ref.grant_id).unwrap(),
            original.persistent_grant(&directory_ref.grant_id).unwrap(),
        ];
        let store = SessionGrantStore::new(root.join("session"));
        store.save_merged(&records).unwrap();
        let required = records
            .iter()
            .map(|record| record.grant_id.clone())
            .collect::<HashSet<_>>();
        let loaded = store.load_for(&required).unwrap();
        assert!(loaded.warning.is_none());
        assert_eq!(loaded.grants.len(), 2);

        let mut restored = GrantRegistry::default();
        for record in loaded.grants {
            restored.restore_persisted_grant(record).unwrap();
        }
        let (opened, path) = restored.open_file(&file_ref).unwrap();
        assert_eq!(path, file.canonicalize().unwrap());
        assert_eq!(opened.metadata().unwrap().len(), 7);
        assert_eq!(
            restored.root_display_name(&directory_ref).as_deref(),
            Some("folder")
        );

        fs::remove_file(&file).unwrap();
        fs::write(&file, b"replacement").unwrap();
        let replacement = store.load_for(&required).unwrap();
        let mut rejected = GrantRegistry::default();
        let file_record = replacement
            .grants
            .into_iter()
            .find(|record| record.kind == GrantKind::File)
            .unwrap();
        assert_eq!(
            rejected
                .restore_persisted_grant(file_record)
                .unwrap_err()
                .code,
            ErrorCode::Conflict
        );
    }

    #[test]
    fn corrupt_grant_store_is_quarantined_without_authorizing_any_path() {
        let root = fixture();
        let session = root.join("session");
        let store = SessionGrantStore::new(session.clone());
        fs::create_dir_all(&session).unwrap();
        fs::write(session.join("grants.json"), b"{not-json").unwrap();
        let loaded = store.load_for(&HashSet::new()).unwrap();
        assert!(loaded.grants.is_empty());
        assert!(loaded.warning.is_some());
        assert!(!session.join("grants.json").exists());
        assert!(fs::read_dir(&session)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| entry
                .file_name()
                .to_string_lossy()
                .starts_with("grants.corrupt-")));
    }

    #[test]
    fn an_owned_atomic_save_updates_the_identity_persisted_for_session_restore() {
        use crate::{
            models::SaveRequest,
            services::{
                files::FileService,
                save::{HardLinkPolicy, PreparedSave},
            },
        };
        let root = fixture();
        let path = root.join("saved.txt");
        fs::write(&path, b"before").unwrap();
        let mut files = FileService::default();
        let reference = files
            .grants
            .register_selection(&path, GrantKind::File)
            .unwrap();
        let before_record = files.grants.persistent_grant(&reference.grant_id).unwrap();
        let opened = files.open_document(reference.clone()).unwrap();
        let request = SaveRequest {
            document_id: opened.document_id.clone(),
            request_id: uuid::Uuid::new_v4().to_string(),
            document_version: 1,
            expected_disk_revision: opened.metadata.disk_revision,
            text: "after".into(),
            format: opened.format,
            newline_map: None,
        };
        PreparedSave::prepare(
            &files,
            request,
            &root.join("save-transactions"),
            HardLinkPolicy::RequireConfirmation,
        )
        .unwrap()
        .commit(&mut files)
        .unwrap();
        let saved_record = files.grants.persistent_grant(&reference.grant_id).unwrap();
        assert_ne!(saved_record.identity_sha256, before_record.identity_sha256);
        let store = SessionGrantStore::new(root.join("session"));
        store.save_merged(&[saved_record]).unwrap();
        let required = HashSet::from([reference.grant_id.clone()]);
        let mut restored = GrantRegistry::default();
        restored
            .restore_persisted_grant(store.load_for(&required).unwrap().grants.remove(0))
            .unwrap();
        assert_eq!(
            restored
                .open_file(&reference)
                .unwrap()
                .0
                .metadata()
                .unwrap()
                .len(),
            5
        );
        assert_eq!(fs::read(&path).unwrap(), b"after");
    }

    #[test]
    fn only_previously_stored_grants_can_be_retained_as_unavailable_session_metadata() {
        let root = fixture();
        let source = root.join("unavailable.txt");
        fs::write(&source, b"original").unwrap();
        let mut registry = GrantRegistry::default();
        let reference = registry
            .register_selection(&source, GrantKind::File)
            .unwrap();
        let store = SessionGrantStore::new(root.join("session"));
        store
            .save_merged(&[registry.persistent_grant(&reference.grant_id).unwrap()])
            .unwrap();
        fs::remove_file(source).unwrap();
        let current = GrantRegistry::default();
        let required = HashSet::from([reference.grant_id.clone()]);
        let records = store.resolve_required(&current, &required).unwrap();
        assert_eq!(records.len(), 1);
        assert!(current.open_file(&reference).is_err());
        let mut restored = GrantRegistry::default();
        assert!(restored
            .restore_persisted_grant(records[0].clone())
            .is_err());
        let unknown = HashSet::from([uuid::Uuid::new_v4().to_string()]);
        assert_eq!(
            store
                .resolve_required(&current, &unknown)
                .err()
                .unwrap()
                .code,
            ErrorCode::SessionIncomplete
        );
    }

    #[test]
    fn revoked_root_cannot_be_reintroduced_by_a_late_session_save() {
        let root = fixture();
        let folder = root.join("revoked");
        fs::create_dir(&folder).unwrap();
        let mut registry = GrantRegistry::default();
        let reference = registry
            .register_selection(&folder, GrantKind::Directory)
            .unwrap();
        let stale_record = registry.persistent_grant(&reference.grant_id).unwrap();
        let store = SessionGrantStore::new(root.join("session"));
        store
            .save_merged(std::slice::from_ref(&stale_record))
            .unwrap();
        store
            .save_with_revocations(&[], std::slice::from_ref(&reference.grant_id))
            .unwrap();
        store.save_merged(&[stale_record]).unwrap();
        assert!(store
            .load_for(&HashSet::from([reference.grant_id.clone()]))
            .unwrap()
            .grants
            .is_empty());
        registry.revoke_directory(&reference).unwrap();
        let reselected = registry
            .register_selection(&folder, GrantKind::Directory)
            .unwrap();
        assert_ne!(reselected.grant_id, reference.grant_id);
        store
            .save_merged(&[registry.persistent_grant(&reselected.grant_id).unwrap()])
            .unwrap();
        assert_eq!(
            store
                .load_for(&HashSet::from([reference.grant_id, reselected.grant_id]))
                .unwrap()
                .grants
                .len(),
            1
        );
    }
}
