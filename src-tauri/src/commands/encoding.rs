use super::{internal_error, SharedFiles};
use crate::{
    models::{AppError, ErrorCode, OpenDocument, ResultEnvelope},
    services::{
        encoding::{inspect_encoding, EncodingInspection},
        save_requests::InFlightSaves,
    },
};
use serde::Deserialize;
use std::sync::Arc;
use tauri::{
    ipc::{InvokeBody, Request},
    AppHandle, Manager,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CheckRequest {
    text: String,
    encoding: String,
    document_version: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ReopenRequest {
    document_id: String,
    encoding: String,
    expected_disk_revision: String,
}

fn parse<T: serde::de::DeserializeOwned>(request: &Request<'_>) -> Result<T, AppError> {
    let InvokeBody::Json(value) = request.body() else {
        return Err(invalid());
    };
    serde_json::from_value(value.clone()).map_err(|_| invalid())
}
fn invalid() -> AppError {
    AppError::new(ErrorCode::InvalidInput, "编码请求格式无效。")
}

#[tauri::command]
pub async fn check_encoding(
    request: Request<'_>,
) -> Result<ResultEnvelope<EncodingInspection>, ()> {
    let request: CheckRequest = match parse(&request) {
        Ok(value) => value,
        Err(error) => return Ok(Err(error).into()),
    };
    Ok(tauri::async_runtime::spawn_blocking(move || {
        inspect_encoding(&request.text, &request.encoding, request.document_version)
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into())
}

#[tauri::command]
pub async fn reopen_with_encoding(
    app: AppHandle,
    request: Request<'_>,
) -> Result<ResultEnvelope<OpenDocument>, ()> {
    let request: ReopenRequest = match parse(&request) {
        Ok(value) => value,
        Err(error) => return Ok(Err(error).into()),
    };
    let files = app.state::<SharedFiles>().inner().clone();
    let active = app.state::<Arc<InFlightSaves>>().inner().clone();
    Ok(tauri::async_runtime::spawn_blocking(move || {
        if uuid::Uuid::parse_str(&request.document_id)
            .ok()
            .map(|id| id.to_string())
            .as_deref()
            != Some(&request.document_id)
            || request.expected_disk_revision.len() != 64
            || !request
                .expected_disk_revision
                .bytes()
                .all(|b| b.is_ascii_hexdigit())
        {
            return Err(invalid());
        }
        let _permit = active.reserve_documents(
            std::slice::from_ref(&request.document_id),
            &uuid::Uuid::new_v4().to_string(),
        )?;
        files
            .lock()
            .map_err(|_| internal_error())?
            .reopen_with_encoding(
                &request.document_id,
                &request.expected_disk_revision,
                Some(&request.encoding),
            )
    })
    .await
    .unwrap_or_else(|_| Err(internal_error()))
    .into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn schemas_reject_paths_unknown_fields_and_unsafe_types() {
        assert!(serde_json::from_value::<ReopenRequest>(serde_json::json!({"documentId":"id","encoding":"gbk","expectedDiskRevision":"revision","path":"foreign"})).is_err());
        assert!(serde_json::from_value::<CheckRequest>(
            serde_json::json!({"text":"body","encoding":"gbk","documentVersion":-1})
        )
        .is_err());
    }
}
