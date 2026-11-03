use super::{internal_error, SharedFiles};
use crate::{
    models::{FileRef, RenamedDocument, ResultEnvelope},
    services::workspace::WorkspaceRoot,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleasedRoot {
    renamed_documents: Vec<RenamedDocument>,
}

#[tauri::command]
pub async fn inspect_workspace_root(
    app: AppHandle,
    root: FileRef,
) -> ResultEnvelope<WorkspaceRoot> {
    let service = app.state::<SharedFiles>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        service
            .lock()
            .map_err(|_| internal_error())?
            .inspect_workspace_root(&root)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into()
}

#[tauri::command]
pub async fn release_workspace_root(app: AppHandle, root: FileRef) -> ResultEnvelope<ReleasedRoot> {
    let service = app.state::<SharedFiles>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let state_root = super::session_root(&app)?;
        service
            .lock()
            .map_err(|_| internal_error())?
            .release_workspace_root(&root, &state_root)
            .map(|renamed_documents| ReleasedRoot { renamed_documents })
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into()
}
