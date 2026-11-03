use crate::{
    models::{
        AppError, ChosenFiles, ChosenFolder, ClearSessionRequest, DirectoryPage,
        DiscardRecoveryRequest, DiscardRecoveryResult, ErrorCode, ListDirectoryRequest,
        ListRecoveryEntriesRequest, LoadRecoveryEntryRequest, LoadSessionRequest,
        LoadedRecoveryEntry, OpenDocument, ReadChunkRequest, RecoveryEntry, RecoveryFailure,
        RecoveryInventory, RecoverySnapshotAck, ReleaseDocumentRequest, ReleaseDocumentResult,
        ResultEnvelope, SaveSessionRequest, SessionClearResult, SessionLoadResult,
        SessionSaveResult, TextChunk, WriteRecoverySnapshotRequest,
    },
    services::{
        files::{FileService, OpenRequestMode},
        grants::GrantKind,
    },
};
use std::sync::{Arc, Mutex};
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager,
};
use tauri_plugin_dialog::DialogExt;
pub mod encoding;
pub mod external;
pub mod file_ops;
pub mod save;
pub mod save_as;
pub mod settings;

type SharedFiles = Arc<Mutex<FileService>>;

fn internal_error() -> AppError {
    AppError::new(ErrorCode::Internal, "本地文件服务暂时不可用，请重试。")
}

#[tauri::command]
pub async fn choose_files(app: AppHandle, multiple: bool) -> ResultEnvelope<ChosenFiles> {
    let service = app.state::<SharedFiles>().inner().clone();
    let Some(parent) = app.get_webview_window("main") else {
        return Err(internal_error()).into();
    };
    tauri::async_runtime::spawn_blocking(move || {
        let dialog = app
            .dialog()
            .file()
            .set_parent(&parent)
            .set_title("打开文件");
        let paths = if multiple {
            dialog.blocking_pick_files().unwrap_or_default()
        } else {
            dialog.blocking_pick_file().into_iter().collect()
        };
        let mut service = service.lock().map_err(|_| internal_error())?;
        let paths = paths.into_iter().map(|selection| {
            selection
                .into_path()
                .map_err(|_| AppError::new(ErrorCode::Unsupported, "请选择本地文件。"))
        });
        Ok(service.grants.register_file_selections(paths))
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into()
}

#[tauri::command]
pub async fn choose_folder(app: AppHandle) -> ResultEnvelope<ChosenFolder> {
    let service = app.state::<SharedFiles>().inner().clone();
    let Some(parent) = app.get_webview_window("main") else {
        return Err(internal_error()).into();
    };
    tauri::async_runtime::spawn_blocking(move || {
        let selection = app
            .dialog()
            .file()
            .set_parent(&parent)
            .set_title("打开文件夹")
            .blocking_pick_folder();
        let (grant, display_name) = if let Some(selection) = selection {
            let path = selection
                .into_path()
                .map_err(|_| AppError::new(ErrorCode::Unsupported, "请选择本地文件夹。"))?;
            let mut service = service.lock().map_err(|_| internal_error())?;
            let grant = service
                .grants
                .register_selection(&path, GrantKind::Directory)?;
            let name = service.grants.root_display_name(&grant);
            (Some(grant), name)
        } else {
            (None, None)
        };
        Ok(ChosenFolder {
            grant,
            display_name,
        })
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into()
}

#[tauri::command]
pub async fn list_directory(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<DirectoryPage>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "目录读取请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: ListDirectoryRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "目录读取请求格式无效。"))?;
        service
            .lock()
            .map_err(|_| internal_error())?
            .list_directory(request)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}

#[tauri::command]
pub async fn open_document(
    app: AppHandle,
    r#ref: serde_json::Value,
    encoding_override: Option<String>,
    mode: Option<String>,
    document_id: Option<String>,
) -> ResultEnvelope<OpenDocument> {
    let service = app.state::<SharedFiles>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let open_mode = match mode.as_deref() {
            None | Some("normal") => OpenRequestMode::Auto,
            Some("head-preview") => OpenRequestMode::HeadPreview,
            Some("text-preview") => OpenRequestMode::TextPreview,
            Some(_) => {
                return Err(AppError::new(
                    ErrorCode::Unsupported,
                    "所选打开模式暂不可用。",
                ))
            }
        };
        let reference = serde_json::from_value(r#ref)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "文件引用格式无效。"))?;
        let result = service
            .lock()
            .map_err(|_| internal_error())?
            .open_document_with_encoding(
                reference,
                open_mode,
                document_id.as_deref(),
                encoding_override.as_deref(),
            );
        result
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into()
}

#[tauri::command]
pub async fn write_recovery_snapshot(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<RecoverySnapshotAck>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "恢复快照请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let active = app
        .state::<Arc<crate::services::save_requests::InFlightSaves>>()
        .inner()
        .clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: WriteRecoverySnapshotRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "恢复快照请求格式无效。"))?;
        let _permit = active.reserve_documents(
            std::slice::from_ref(&request.document_id),
            &uuid::Uuid::new_v4().to_string(),
        )?;
        let snapshot = service
            .lock()
            .map_err(|_| internal_error())?
            .prepare_recovery_snapshot(request)?;
        let root = save::journal_root(&app)?.with_file_name("recovery");
        let draft =
            crate::services::recovery::RecoveryStore::new(root).persist_snapshot(snapshot)?;
        Ok(RecoverySnapshotAck {
            document_id: draft.manifest.document_id,
            durable_version: draft.manifest.buffer_version,
            receipt_id: draft.manifest.receipt_id,
            written_at: draft.manifest.created_at,
        })
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}

fn recovery_entry(manifest: crate::services::recovery::RecoveryManifest) -> RecoveryEntry {
    RecoveryEntry {
        receipt_id: manifest.receipt_id,
        reason: manifest.reason,
        document_id: manifest.document_id,
        buffer_version: manifest.buffer_version,
        source_path: manifest
            .source_path
            .map(|path| path.to_string_lossy().into_owned()),
        source_revision: manifest.source_revision,
        format: manifest.format,
        newline_map: manifest.newline_map,
        body_bytes: manifest.body_bytes,
        body_sha256: manifest.body_sha256,
        created_at: manifest.created_at,
    }
}

#[tauri::command]
pub async fn list_recovery_entries(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<RecoveryInventory>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "恢复列表请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _: ListRecoveryEntriesRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "恢复列表请求格式无效。"))?;
        let transaction_root = save::journal_root(&app)?;
        let recovery_root = transaction_root.with_file_name("recovery");
        let recovery_store = crate::services::recovery::RecoveryStore::new(recovery_root);
        let scan = recovery_store.scan()?;
        let transaction_scan = match crate::services::startup_storage::scan_save_transactions(
            &transaction_root,
            &recovery_store,
        ) {
            Ok(scan) => scan,
            Err(error) => {
                let mut scan = crate::services::startup_storage::SaveTransactionScan::default();
                scan.warnings.push(format!(
                    "保存事务目录无法完整扫描：{} 已保留且未自动清理。",
                    error.message
                ));
                scan
            }
        };
        let mut startup_warnings = transaction_scan.warnings;
        let storage_bytes = scan
            .storage_bytes
            .saturating_add(transaction_scan.bytes);
        if storage_bytes > crate::services::recovery::MAX_RECOVERY_BYTES {
            startup_warnings.push(format!(
                "恢复副本与保存事务合计占用 {} MiB，超过 256 MiB 管理上限；请先核对并清理冗余记录。",
                storage_bytes.div_ceil(1024 * 1024)
            ));
        }
        Ok(RecoveryInventory {
            entries: scan.entries.into_iter().map(recovery_entry).collect(),
            failures: scan
                .failures
                .into_iter()
                .map(|failure| RecoveryFailure {
                    entry_id: failure.entry_id,
                    message: failure.message,
                })
                .collect(),
            startup_warnings,
            storage_bytes,
            save_transactions: transaction_scan.candidates,
        })
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}

#[tauri::command]
pub async fn load_recovery_entry(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<LoadedRecoveryEntry>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "读取恢复条目请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: LoadRecoveryEntryRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "读取恢复条目请求格式无效。"))?;
        let root = save::journal_root(&app)?.with_file_name("recovery");
        let draft =
            crate::services::recovery::RecoveryStore::new(root).load(&request.receipt_id)?;
        Ok(LoadedRecoveryEntry {
            entry: recovery_entry(draft.manifest),
            text: draft.text,
        })
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}

fn session_root(app: &AppHandle) -> Result<std::path::PathBuf, AppError> {
    Ok(save::journal_root(app)?.with_file_name("session"))
}

#[tauri::command]
pub async fn load_save_transaction(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<crate::models::LoadedSaveTransaction>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "读取保存事务请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: LoadRecoveryEntryRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "读取保存事务请求格式无效。"))?;
        let root = save::journal_root(&app)?;
        let recovery =
            crate::services::recovery::RecoveryStore::new(root.with_file_name("recovery"));
        crate::services::startup_storage::load_save_transaction(
            &root,
            &request.receipt_id,
            &recovery,
        )
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}

#[tauri::command]
pub async fn save_session(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<SessionSaveResult>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "保存会话请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: SaveSessionRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "保存会话请求格式无效。"))?;
        let manifest = crate::services::session::validate_manifest(request.manifest)?;
        let ids = crate::services::session::grant_ids(&manifest);
        let root = session_root(&app)?;
        let grant_store = crate::services::session_grants::SessionGrantStore::new(root.clone());
        let grants = {
            let files = service.lock().map_err(|_| internal_error())?;
            grant_store.resolve_required(&files.grants, &ids)?
        };
        grant_store.save_merged(&grants)?;
        crate::services::session::SessionStore::new(root).save(&manifest)?;
        Ok(SessionSaveResult {
            saved: true,
            persisted_at: manifest.persisted_at,
        })
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}

#[tauri::command]
pub async fn load_session(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<SessionLoadResult>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "读取会话请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: LoadSessionRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "读取会话请求格式无效。"))?;
        if request.restore_grant_ids.len() > 50
            || request.restore_grant_ids.iter().any(|id| {
                uuid::Uuid::parse_str(id)
                    .ok()
                    .map(|parsed| parsed.to_string())
                    .as_deref()
                    != Some(id.as_str())
            })
        {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "最近记录授权标识格式无效。",
            ));
        }
        let root = session_root(&app)?;
        let mut loaded = crate::services::session::SessionStore::new(root.clone()).load()?;
        let required = loaded
            .session
            .as_ref()
            .map(crate::services::session::grant_ids)
            .unwrap_or_default();
        let mut requested = required.clone();
        requested.extend(request.restore_grant_ids);
        if loaded.session.is_none() {
            if requested.is_empty() {
                return Ok(loaded);
            }
            let grant_load = crate::services::session_grants::SessionGrantStore::new(root)
                .load_for(&requested)
                .unwrap_or(crate::services::session_grants::SessionGrantLoad {
                    grants: Vec::new(),
                    warning: None,
                });
            let mut restored = Vec::new();
            {
                let mut files = service.lock().map_err(|_| internal_error())?;
                for grant in grant_load.grants {
                    let grant_id = grant.grant_id.clone();
                    if files.grants.restore_persisted_grant(grant).is_ok() {
                        restored.push(grant_id);
                    }
                }
            }
            loaded.restored_grant_ids = restored;
            return Ok(loaded);
        }
        let mut warnings = loaded.warning.into_iter().collect::<Vec<_>>();
        let grant_load = match crate::services::session_grants::SessionGrantStore::new(root)
            .load_for(&requested)
        {
            Ok(load) => load,
            Err(error) => {
                warnings.push(error.message);
                crate::services::session_grants::SessionGrantLoad {
                    grants: Vec::new(),
                    warning: None,
                }
            }
        };
        if let Some(warning) = grant_load.warning {
            warnings.push(warning);
        }
        let mut restored = Vec::new();
        {
            let mut files = service.lock().map_err(|_| internal_error())?;
            for grant in grant_load.grants {
                let grant_id = grant.grant_id.clone();
                match files.grants.restore_persisted_grant(grant) {
                    Ok(_) => restored.push(grant_id),
                    Err(error) => warnings.push(error.message),
                }
            }
        }
        let missing = required.iter().filter(|id| !restored.contains(id)).count();
        if missing > 0 {
            warnings.push(format!(
                "{missing} 个会话文件或工作区授权未能安全恢复，请重新选择对应项目。"
            ));
        }
        loaded.warning = (!warnings.is_empty()).then(|| {
            let mut unique = warnings;
            unique.sort();
            unique.dedup();
            unique.join(" ")
        });
        loaded.restored_grant_ids = restored;
        Ok(loaded)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}

#[tauri::command]
pub async fn clear_session(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<SessionClearResult>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "清理会话请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let result = tauri::async_runtime::spawn_blocking(move || {
        let _: ClearSessionRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "清理会话请求格式无效。"))?;
        crate::services::session::SessionStore::new(session_root(&app)?).clear()?;
        Ok(SessionClearResult { cleared: true })
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}

#[tauri::command]
pub async fn discard_recovery(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<DiscardRecoveryResult>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "放弃恢复请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let active = app
        .state::<Arc<crate::services::save_requests::InFlightSaves>>()
        .inner()
        .clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: DiscardRecoveryRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "放弃恢复请求格式无效。"))?;
        let _permit = active.reserve_documents(
            std::slice::from_ref(&request.document_id),
            &uuid::Uuid::new_v4().to_string(),
        )?;
        let recovery = save::journal_root(&app)?.with_file_name("recovery");
        crate::services::recovery::RecoveryStore::new(recovery)
            .discard_through(&request.document_id, request.through_version)?;
        Ok(DiscardRecoveryResult {
            document_id: request.document_id,
            through_version: request.through_version,
            discarded: true,
        })
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}

#[tauri::command]
pub async fn release_document(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<ReleaseDocumentResult>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "文档释放请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let active = app
        .state::<Arc<crate::services::save_requests::InFlightSaves>>()
        .inner()
        .clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: ReleaseDocumentRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "文档释放请求格式无效。"))?;
        let _permit = active.reserve_documents(
            std::slice::from_ref(&request.document_id),
            &uuid::Uuid::new_v4().to_string(),
        )?;
        let released = service
            .lock()
            .map_err(|_| internal_error())?
            .release_document(&request.document_id)?;
        Ok(ReleaseDocumentResult { released })
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}

#[tauri::command]
pub async fn read_document_chunk(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<TextChunk>, ()> {
    let value = match request.body() {
        InvokeBody::Json(value) => value.clone(),
        _ => {
            return Ok(Err(AppError::new(
                ErrorCode::InvalidInput,
                "分块读取请求必须为JSON对象。",
            ))
            .into())
        }
    };
    let service = app.state::<SharedFiles>().inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        let request: ReadChunkRequest = serde_json::from_value(value)
            .map_err(|_| AppError::new(ErrorCode::InvalidInput, "分块读取请求格式无效。"))?;
        service
            .lock()
            .map_err(|_| internal_error())?
            .read_document_chunk(request)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()));
    Ok(result.into())
}
