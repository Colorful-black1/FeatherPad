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
    let encoding = request.format.encoding.as_str();
    let bom: &[u8] = match (encoding, request.format.bom.as_str()) {
        ("utf-8" | "utf-16le" | "utf-16be", "none") => &[],
        ("utf-8", "utf8") => &[0xef, 0xbb, 0xbf],
        ("utf-16le", "utf16le") => &[0xff, 0xfe],
        ("utf-16be", "utf16be") => &[0xfe, 0xff],
        ("utf-8" | "utf-16le" | "utf-16be", _) => return Err(invalid_snapshot()),
        _ => {
            return Err(AppError::new(
                ErrorCode::Unsupported,
                "此编码尚未提供安全写入，请使用UTF-8另存。",
            ))
        }
    };
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
    let mut bytes = bom.to_vec();
    if encoding == "utf-8" {
        bytes.extend_from_slice(expanded.as_bytes());
    } else {
        for unit in expanded.encode_utf16() {
            bytes.extend_from_slice(&if encoding == "utf-16le" {
                unit.to_le_bytes()
            } else {
                unit.to_be_bytes()
            });
        }
    }
    Ok(bytes)
}

fn invalid_snapshot() -> AppError {
    AppError::new(
        ErrorCode::InvalidInput,
        "保存快照的正文、编码/BOM或逐行换行映射不一致，请重试。",
    )
}
