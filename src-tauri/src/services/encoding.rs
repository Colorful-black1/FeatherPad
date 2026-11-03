use super::text::{decode_basic, DecodedText};
use crate::models::{AppError, ErrorCode};
use windows_sys::Win32::Globalization::{
    MultiByteToWideChar, WideCharToMultiByte, MB_ERR_INVALID_CHARS, WC_ERR_INVALID_CHARS,
    WC_NO_BEST_FIT_CHARS,
};

pub const LABELS: [&str; 8] = [
    "utf-8",
    "utf-16le",
    "utf-16be",
    "gb18030",
    "gbk",
    "shift_jis",
    "big5",
    "windows-1252",
];

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EncodingInspection {
    pub encoding: String,
    pub document_version: u64,
    pub loss_count: usize,
    pub samples: Vec<LossPosition>,
    pub replacement_text: Option<String>,
}

#[derive(Debug, serde::Serialize)]
pub struct LossPosition {
    pub offset: usize,
    pub length: usize,
}

pub fn inspect_encoding(
    text: &str,
    encoding: &str,
    version: u64,
) -> Result<EncodingInspection, AppError> {
    if text.len() > super::save::MAX_SNAPSHOT_BYTES
        || version > 9_007_199_254_740_991
        || text.contains('\r')
    {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "编码检查快照无效或超过64MiB。",
        ));
    }
    let mut result = EncodingInspection {
        encoding: encoding.to_owned(),
        document_version: version,
        loss_count: 0,
        samples: Vec::new(),
        replacement_text: None,
    };
    match encode_text(text, encoding, "none") {
        Ok(_) => return Ok(result),
        Err(error) if error.code == ErrorCode::LossyEncoding => {}
        Err(error) => return Err(error),
    }
    let mut cache = std::collections::HashMap::new();
    let mut replacement = String::with_capacity(text.len());
    let mut offset = 0;
    for character in text.chars() {
        let representable = character.is_ascii()
            || *cache.entry(character).or_insert_with(|| {
                let mut bytes = [0u8; 4];
                encode_text(character.encode_utf8(&mut bytes), encoding, "none").is_ok()
            });
        if representable {
            replacement.push(character);
        } else {
            replacement.push('?');
            result.loss_count += 1;
            if result.samples.len() < 32 {
                result.samples.push(LossPosition {
                    offset,
                    length: character.len_utf16(),
                });
            }
        }
        offset += character.len_utf16();
    }
    if result.loss_count == 0 {
        return Err(loss());
    }
    encode_text(&replacement, encoding, "none")?;
    result.replacement_text = Some(replacement);
    Ok(result)
}

fn code_page(label: &str) -> Result<u32, AppError> {
    match label {
        "gb18030" => Ok(54936),
        "gbk" => Ok(936),
        "shift_jis" => Ok(932),
        "big5" => Ok(950),
        "windows-1252" => Ok(1252),
        _ => Err(AppError::new(ErrorCode::Unsupported, "不支持所选编码。")),
    }
}

fn loss() -> AppError {
    AppError::new(
        ErrorCode::LossyEncoding,
        "无法按所选编码无损往返；原内容已保留，请选择其他编码。",
    )
}

fn decode_legacy(bytes: &[u8], page: u32) -> Result<String, AppError> {
    if bytes.is_empty() {
        return Ok(String::new());
    }
    let length = i32::try_from(bytes.len()).map_err(|_| loss())?;
    // Explicit positive lengths include embedded NUL; buffers use the API's UTF-16 unit count.
    let size = unsafe {
        MultiByteToWideChar(
            page,
            MB_ERR_INVALID_CHARS,
            bytes.as_ptr(),
            length,
            std::ptr::null_mut(),
            0,
        )
    };
    if size <= 0 {
        return Err(loss());
    }
    let mut units = vec![0u16; size as usize];
    let written = unsafe {
        MultiByteToWideChar(
            page,
            MB_ERR_INVALID_CHARS,
            bytes.as_ptr(),
            length,
            units.as_mut_ptr(),
            size,
        )
    };
    if written != size {
        return Err(loss());
    }
    String::from_utf16(&units).map_err(|_| loss())
}

fn encode_legacy(text: &str, page: u32) -> Result<Vec<u8>, AppError> {
    if text.is_empty() {
        return Ok(Vec::new());
    }
    let units: Vec<u16> = text.encode_utf16().collect();
    let length = i32::try_from(units.len()).map_err(|_| loss())?;
    let flags = if page == 54936 {
        WC_ERR_INVALID_CHARS
    } else {
        WC_NO_BEST_FIT_CHARS
    };
    let mut replaced = 0;
    // GB18030 requires NULL default-character arguments; other pages explicitly reject defaults.
    let used = if page == 54936 {
        std::ptr::null_mut()
    } else {
        &mut replaced
    };
    let size = unsafe {
        WideCharToMultiByte(
            page,
            flags,
            units.as_ptr(),
            length,
            std::ptr::null_mut(),
            0,
            std::ptr::null(),
            used,
        )
    };
    if size <= 0 || replaced != 0 {
        return Err(loss());
    }
    let mut bytes = vec![0u8; size as usize];
    let written = unsafe {
        WideCharToMultiByte(
            page,
            flags,
            units.as_ptr(),
            length,
            bytes.as_mut_ptr(),
            size,
            std::ptr::null(),
            used,
        )
    };
    if written != size || replaced != 0 {
        return Err(loss());
    }
    if decode_legacy(&bytes, page)? != text {
        return Err(loss());
    }
    Ok(bytes)
}

pub fn encode_text(text: &str, encoding: &str, bom: &str) -> Result<Vec<u8>, AppError> {
    let prefix: &[u8] = match (encoding, bom) {
        (_, "none") if LABELS.contains(&encoding) => &[],
        ("utf-8", "utf8") => &[0xef, 0xbb, 0xbf],
        ("utf-16le", "utf16le") => &[0xff, 0xfe],
        ("utf-16be", "utf16be") => &[0xfe, 0xff],
        _ if !LABELS.contains(&encoding) => {
            return Err(AppError::new(ErrorCode::Unsupported, "不支持所选编码。"))
        }
        _ => return Err(AppError::new(ErrorCode::InvalidInput, "编码与BOM不匹配。")),
    };
    let mut bytes = prefix.to_vec();
    match encoding {
        "utf-8" => bytes.extend_from_slice(text.as_bytes()),
        "utf-16le" | "utf-16be" => {
            for unit in text.encode_utf16() {
                bytes.extend_from_slice(&if encoding == "utf-16le" {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                });
            }
        }
        _ => bytes.extend(encode_legacy(text, code_page(encoding)?)?),
    }
    Ok(bytes)
}

pub fn decode_text(bytes: &[u8], encoding: Option<&str>) -> Result<DecodedText, AppError> {
    let Some(label) = encoding else {
        return decode_basic(bytes);
    };
    let label = LABELS
        .iter()
        .copied()
        .find(|value| *value == label)
        .ok_or_else(|| AppError::new(ErrorCode::Unsupported, "不支持所选编码。"))?;
    let detected = if bytes.starts_with(&[0xff, 0xfe]) {
        Some("utf-16le")
    } else if bytes.starts_with(&[0xfe, 0xff]) {
        Some("utf-16be")
    } else if bytes.starts_with(&[0xef, 0xbb, 0xbf]) {
        Some("utf-8")
    } else {
        None
    };
    if detected.is_some_and(|bom| bom != label) {
        return Err(loss());
    }
    if detected.is_some() || label == "utf-8" {
        return decode_basic(bytes);
    }
    let text = if label == "utf-16le" || label == "utf-16be" {
        let (pairs, remainder) = bytes.as_chunks::<2>();
        if !remainder.is_empty() {
            return Err(loss());
        }
        let units: Vec<u16> = pairs
            .iter()
            .map(|pair| {
                if label == "utf-16le" {
                    u16::from_le_bytes(*pair)
                } else {
                    u16::from_be_bytes(*pair)
                }
            })
            .collect();
        String::from_utf16(&units).map_err(|_| loss())?
    } else {
        decode_legacy(bytes, code_page(label)?)?
    };
    if encode_text(&text, label, "none")? != bytes {
        return Err(loss());
    }
    Ok(DecodedText {
        text,
        encoding: label,
        bom: "none",
    })
}
