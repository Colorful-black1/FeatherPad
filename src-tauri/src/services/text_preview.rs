use super::{
    identity::FileIdentity,
    open_policy::{has_long_line, CHUNKED_THRESHOLD},
    snapshot::read_snapshot,
    stream_snapshot::{read_raw_preview_window, HEAD_PREVIEW_BYTES},
    text::{decode_basic, normalize_newlines, DecodedText},
};
use crate::models::{io_error, AppError, FileMetadata, TextFormat};
use std::{fs::File, path::PathBuf};

impl super::files::FileService {
    pub(super) fn open_text_preview(
        &mut self,
        reference: crate::models::FileRef,
        file: File,
        preferred_id: Option<&str>,
    ) -> Result<crate::models::OpenDocument, AppError> {
        let preview = read_text_preview(file)?;
        let canonical_identity = super::files::canonical_identity(&preview.identity);
        let document_id = self.documents.register_preferred(
            super::documents::DocumentLease {
                identity: preview.identity,
                reference: reference.clone(),
                path: preview.path,
                file: preview.file,
            },
            preferred_id,
        )?;
        self.documents.mark_text_preview(&document_id);
        Ok(crate::models::OpenDocument {
            document_id,
            canonical_identity,
            write_owner_window_id: None,
            writable: true,
            reference,
            metadata: preview.metadata.clone(),
            format: preview.format,
            warnings: preview.warnings,
            mode: "text-preview",
            content: crate::models::OpenDocumentContent::Head {
                text: preview.text,
                preview_bytes: preview.preview_bytes,
                total_bytes: preview.metadata.size_bytes,
                truncated: preview.truncated,
            },
        })
    }
}

pub(super) struct TextPreviewSnapshot {
    pub file: File,
    pub path: PathBuf,
    pub identity: FileIdentity,
    pub metadata: FileMetadata,
    pub text: String,
    pub format: TextFormat,
    pub warnings: Vec<String>,
    pub preview_bytes: u64,
    pub truncated: bool,
}

pub(super) fn read_text_preview(file: File) -> Result<TextPreviewSnapshot, AppError> {
    let size = file.metadata().map_err(io_error)?.len();
    let (file, path, identity, metadata, bytes) = if size < CHUNKED_THRESHOLD {
        let snapshot = read_snapshot(file, CHUNKED_THRESHOLD - 1)?;
        (
            snapshot.file,
            snapshot.path,
            snapshot.identity,
            snapshot.metadata,
            snapshot.bytes,
        )
    } else {
        let snapshot = read_raw_preview_window(file, 0..HEAD_PREVIEW_BYTES + 8)?;
        (
            snapshot.file,
            snapshot.path,
            snapshot.identity,
            snapshot.metadata,
            snapshot.window,
        )
    };
    let end = if metadata.size_bytes >= CHUNKED_THRESHOLD {
        preview_end(&bytes, HEAD_PREVIEW_BYTES as usize)
    } else {
        bytes.len()
    };
    let (decoded, lossy) = decode_preview(&bytes[..end]);
    let (normalized, endings) = normalize_newlines(&decoded.text);
    let mut controls = false;
    let text: String = normalized
        .chars()
        .map(|character| {
            if character.is_control() && !matches!(character, '\n' | '\t') {
                controls = true;
                match character {
                    '\u{7f}' => '\u{2421}',
                    '\0'..='\u{1f}' => char::from_u32(0x2400 + character as u32).unwrap(),
                    _ => '\u{fffd}',
                }
            } else {
                character
            }
        })
        .collect();
    let mut warnings = Vec::new();
    if has_long_line(&text) {
        warnings.push(
            "试开内容含超过100,000字符的长行，已关闭软换行；可水平滚动查看，试读范围不变。".into(),
        );
    }
    if lossy {
        warnings.push("存在无法按所示编码解释的字节，已用替代字符显示；原始字节未改变。".into());
    }
    if controls {
        warnings.push("控制字符已可见化显示（例如␀），显示内容不等同于原始字节。".into());
    }
    let truncated = (end as u64) < metadata.size_bytes;
    if truncated {
        warnings.push("文件从20MiB起只试读前1MiB；此处为截断预览。".into());
    }
    let line_ending = if endings.contains(&crate::models::Newline::Cr)
        || (endings.contains(&crate::models::Newline::Lf)
            && endings.contains(&crate::models::Newline::Crlf))
    {
        "mixed"
    } else if endings.contains(&crate::models::Newline::Lf) {
        "lf"
    } else {
        "crlf"
    };
    Ok(TextPreviewSnapshot {
        file,
        path,
        identity,
        metadata,
        text,
        format: TextFormat {
            encoding: decoded.encoding.into(),
            bom: decoded.bom.into(),
            line_ending: line_ending.into(),
        },
        warnings,
        preview_bytes: end as u64,
        truncated,
    })
}

fn preview_end(bytes: &[u8], cap: usize) -> usize {
    let mut end = cap.min(bytes.len());
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let little = bytes[0] == 0xff;
        end -= (end - 2) % 2;
        let unit = |offset| {
            let pair = [bytes[offset], bytes[offset + 1]];
            if little {
                u16::from_le_bytes(pair)
            } else {
                u16::from_be_bytes(pair)
            }
        };
        if end >= 4
            && end + 1 < bytes.len()
            && (0xd800..=0xdbff).contains(&unit(end - 2))
            && (0xdc00..=0xdfff).contains(&unit(end))
        {
            end -= 2;
        }
    } else {
        // Only trim a valid code point straddling the boundary. Invalid continuation
        // runs must remain visible as replacement characters, not vanish from preview.
        for start in end.saturating_sub(3)..end {
            let width = match bytes[start] {
                0xc2..=0xdf => 2,
                0xe0..=0xef => 3,
                0xf0..=0xf4 => 4,
                _ => continue,
            };
            if start + width > end
                && start + width <= bytes.len()
                && std::str::from_utf8(&bytes[start..start + width]).is_ok()
            {
                end = start;
                break;
            }
        }
    }
    end
}

fn decode_preview(bytes: &[u8]) -> (DecodedText, bool) {
    if let Ok(decoded) = decode_basic(bytes) {
        return (decoded, false);
    }
    if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let little = bytes[0] == 0xff;
        let (pairs, tail) = bytes[2..].as_chunks::<2>();
        let units: Vec<_> = pairs
            .iter()
            .map(|pair| {
                if little {
                    u16::from_le_bytes(*pair)
                } else {
                    u16::from_be_bytes(*pair)
                }
            })
            .collect();
        let mut text = String::from_utf16_lossy(&units);
        if !tail.is_empty() {
            text.push('\u{fffd}');
        }
        (
            DecodedText {
                text,
                encoding: if little { "utf-16le" } else { "utf-16be" },
                bom: if little { "utf16le" } else { "utf16be" },
            },
            true,
        )
    } else {
        let (source, bom) = bytes
            .strip_prefix(&[0xef, 0xbb, 0xbf])
            .map_or((bytes, "none"), |source| (source, "utf8"));
        (
            DecodedText {
                text: String::from_utf8_lossy(source).into_owned(),
                encoding: "utf-8",
                bom,
            },
            true,
        )
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::{
        fs,
        io::{Seek, SeekFrom, Write},
    };

    fn fixture(bytes: &[u8]) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".artifacts/T115/text-preview-core")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let path = root.join("只读试开😀.bin");
        fs::write(&path, bytes).unwrap();
        path
    }

    #[test]
    fn invalid_utf8_and_controls_are_visible_without_changing_original_bytes() {
        let bytes = b"\xef\xbb\xbfhi\0\xff\r\n";
        let path = fixture(bytes);
        let preview = read_text_preview(File::open(&path).unwrap()).unwrap();
        assert_eq!(preview.text, "hi␀�\n");
        assert_eq!(preview.format.encoding, "utf-8");
        assert_eq!(preview.format.bom, "utf8");
        assert_eq!(preview.preview_bytes, bytes.len() as u64);
        assert!(!preview.truncated);
        assert!(preview
            .warnings
            .iter()
            .any(|warning| warning.contains("替代字符")));
        assert_eq!(fs::read(path).unwrap(), bytes);
    }

    #[test]
    fn utf16_bom_precedes_binary_detection_and_malformed_units_are_explicit() {
        for little in [true, false] {
            let mut bytes = if little {
                vec![0xff, 0xfe]
            } else {
                vec![0xfe, 0xff]
            };
            for unit in "中文😀\0".encode_utf16().chain([0xd800]) {
                bytes.extend_from_slice(&if little {
                    unit.to_le_bytes()
                } else {
                    unit.to_be_bytes()
                });
            }
            let path = fixture(&bytes);
            let preview = read_text_preview(File::open(&path).unwrap()).unwrap();
            assert_eq!(preview.text, "中文😀␀�");
            assert_eq!(
                preview.format.encoding,
                if little { "utf-16le" } else { "utf-16be" }
            );
            assert_eq!(fs::read(path).unwrap(), bytes);
        }
    }

    #[test]
    fn truncation_keeps_whole_valid_code_points_and_does_not_hide_invalid_runs() {
        assert_eq!(preview_end("a😀b".as_bytes(), 3), 1);
        assert_eq!(preview_end(&[0x80; 8], 4), 4);
        assert_eq!(
            preview_end(&[0xff, 0xfe, 0x3d, 0xd8, 0x00, 0xde, 0, 0], 4),
            2
        );
    }

    #[test]
    fn large_binary_preview_is_bounded_and_hashes_changes_outside_the_window() {
        let path = fixture(b"binary\0");
        File::options()
            .write(true)
            .open(&path)
            .unwrap()
            .set_len(CHUNKED_THRESHOLD)
            .unwrap();
        let before = read_text_preview(File::open(&path).unwrap()).unwrap();
        assert_eq!(before.preview_bytes, HEAD_PREVIEW_BYTES);
        assert!(before.truncated);
        assert_eq!(before.metadata.size_bytes, CHUNKED_THRESHOLD);
        assert_eq!(before.text.chars().count(), HEAD_PREVIEW_BYTES as usize);
        assert!(before
            .warnings
            .iter()
            .any(|warning| warning.contains("水平滚动")));
        let modified = fs::metadata(&path).unwrap().modified().unwrap();
        let mut writer = File::options().write(true).open(&path).unwrap();
        writer.seek(SeekFrom::End(-1)).unwrap();
        writer.write_all(b"x").unwrap();
        writer
            .set_times(fs::FileTimes::new().set_modified(modified))
            .unwrap();
        let after = read_text_preview(File::open(&path).unwrap()).unwrap();
        assert_ne!(before.metadata.disk_revision, after.metadata.disk_revision);
        assert_eq!(before.text, after.text);
        assert_eq!(fs::metadata(path).unwrap().len(), CHUNKED_THRESHOLD);
    }
}
