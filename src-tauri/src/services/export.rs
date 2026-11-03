use crate::models::{
    AppError, ErrorCode, Newline, NewlineMap, SaveAsRequest, SaveIntent, TextFormat,
};

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HtmlExportRequest {
    pub document_id: String,
    pub request_id: String,
    pub document_version: u64,
    pub html: String,
}

impl HtmlExportRequest {
    pub fn into_snapshot(self) -> Result<SaveAsRequest, AppError> {
        if uuid::Uuid::parse_str(&self.document_id).is_err()
            || uuid::Uuid::parse_str(&self.request_id).is_err()
            || self.html.len() > super::save::MAX_SNAPSHOT_BYTES
            || self.html.contains('\r')
            || !self.html.starts_with("<!doctype html>")
        {
            return Err(AppError::new(
                ErrorCode::InvalidInput,
                "HTML导出快照格式无效或超过64MiB。",
            ));
        }
        let count = self.html.bytes().filter(|byte| *byte == b'\n').count();
        Ok(SaveAsRequest {
            document_id: self.document_id,
            request_id: self.request_id,
            document_version: self.document_version,
            text: self.html,
            format: TextFormat {
                encoding: "utf-8".into(),
                bom: "none".into(),
                line_ending: "lf".into(),
            },
            newline_map: Some(NewlineMap {
                document_version: self.document_version,
                endings: vec![Newline::Lf; count],
            }),
            intent: SaveIntent::Copy,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn html_export_forces_utf8_copy_and_exact_newlines() {
        let request = HtmlExportRequest {
            document_id: uuid::Uuid::new_v4().to_string(),
            request_id: uuid::Uuid::new_v4().to_string(),
            document_version: 7,
            html: "<!doctype html><p>中文</p>\n".into(),
        }
        .into_snapshot()
        .unwrap();
        assert_eq!(request.intent, SaveIntent::Copy);
        assert_eq!(request.format.encoding, "utf-8");
        assert_eq!(
            request.newline_map.unwrap(),
            NewlineMap {
                document_version: 7,
                endings: vec![Newline::Lf]
            }
        );
    }
}
