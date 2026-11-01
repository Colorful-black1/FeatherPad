use crate::models::{AppError, ErrorCode, Newline};

pub struct DecodedText {
    pub text: String,
    pub encoding: &'static str,
    pub bom: &'static str,
}

pub fn decode_basic(bytes: &[u8]) -> Result<DecodedText, AppError> {
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let (pairs, remainder) = bytes[2..].as_chunks::<2>();
        if !remainder.is_empty() {
            return Err(invalid_utf16());
        }
        let little = bytes[0] == 0xff;
        let units = pairs
            .iter()
            .map(|pair| {
                if little {
                    u16::from_le_bytes(*pair)
                } else {
                    u16::from_be_bytes(*pair)
                }
            })
            .collect::<Vec<_>>();
        let text = String::from_utf16(&units).map_err(|_| invalid_utf16())?;
        Ok(DecodedText {
            text,
            encoding: if little { "utf-16le" } else { "utf-16be" },
            bom: if little { "utf16le" } else { "utf16be" },
        })
    } else {
        let (source, bom) = bytes
            .strip_prefix(&[0xef, 0xbb, 0xbf])
            .map_or((bytes, "none"), |source| (source, "utf8"));
        let text = std::str::from_utf8(source)
            .map_err(|_| {
                AppError::new(
                    ErrorCode::EncodingRequired,
                    "无法按UTF-8读取，请选择合适的编码。",
                )
            })?
            .to_owned();
        Ok(DecodedText {
            text,
            encoding: "utf-8",
            bom,
        })
    }
}

fn invalid_utf16() -> AppError {
    AppError::new(
        ErrorCode::LossyEncoding,
        "无法无损读取UTF-16，请检查文件编码。",
    )
}

pub fn normalize_newlines(source: &str) -> (String, Vec<Newline>) {
    let mut text = String::with_capacity(source.len());
    let mut endings = Vec::new();
    let mut chars = source.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '\r' => {
                if chars.peek() == Some(&'\n') {
                    chars.next();
                    endings.push(Newline::Crlf);
                } else {
                    endings.push(Newline::Cr);
                }
                text.push('\n');
            }
            '\n' => {
                endings.push(Newline::Lf);
                text.push('\n');
            }
            _ => text.push(c),
        }
    }
    (text, endings)
}
