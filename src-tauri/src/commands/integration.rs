use crate::{models::ResultEnvelope, platform::windows::associations};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntegrationRequest {
    pub file_association: bool,
    pub context_menu: bool,
}

#[tauri::command]
pub async fn get_desktop_integration() -> ResultEnvelope<associations::IntegrationStatus> {
    associations::status().into()
}

#[tauri::command]
pub async fn set_desktop_integration(
    request: IntegrationRequest,
) -> ResultEnvelope<associations::IntegrationStatus> {
    associations::apply(request.file_association, request.context_menu).into()
}
