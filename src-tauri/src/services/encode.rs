use crate::models::{AppError, ErrorCode, Newline, SaveRequest};

pub fn encode_snapshot(request: &SaveRequest) -> Result<Vec<u8>, AppError> {
    if request.document_version > 9_007_199_254_740_991 || request.text.contains('\r') {
        return Err(invalid_snapshot());
    }
    let default = match request.format.line_ending.as_str() {
        "lf" => Some(Newline::Lf),
        "crlf" => Some(Newline::Crlf),
        "mixed" => None,
        _ => return Err(invalid_snapshot()),
    };
    let count = request.text.bytes().filter(|byte| *byte == b'\n').count();
    match &request.newline_map {
        Some(map) => {
            if map.document_version != request.document_version
                || map.endings.len() != count
                || default.is_some_and(|ending| map.endings.iter().any(|item| *item != ending))
            {
                return Err(invalid_snapshot());
            }
        }
        None if default.is_none() => return Err(invalid_snapshot()),
        None => {}
    }
    let mut expanded = String::with_capacity(request.text.len());
    for (index, part) in request.text.split('\n').enumerate() {
        if index > 0 {
            let ending = request
                .newline_map
                .as_ref()
                .map(|map| map.endings[index - 1])
                .or(default)
                .ok_or_else(invalid_snapshot)?;
            expanded.push_str(match ending {
                Newline::Lf => "\n",
                Newline::Crlf => "\r\n",
                Newline::Cr => "\r",
            });
        }
        expanded.push_str(part);
    }
    super::encoding::encode_text(&expanded, &request.format.encoding, &request.format.bom)
}

fn invalid_snapshot() -> AppError {
    AppError::new(
        ErrorCode::InvalidInput,
        "保存快照的正文、编码/BOM或逐行换行映射不一致，请重试。",
    )
}
