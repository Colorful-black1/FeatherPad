use super::{
    grants::opened_file_path,
    identity::{identify, FileIdentity},
    snapshot::finish_metadata,
    text::normalize_newlines,
};
use crate::models::{io_error, AppError, ErrorCode, FileMetadata};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    ops::Range,
    path::PathBuf,
};

pub const MAX_WINDOW_BYTES: u64 = 1024 * 1024 + 8;
pub const INITIAL_CHUNK_BYTES: u64 = 64 * 1024;
pub const MAX_CHUNK_BYTES: u64 = 1024 * 1024;
pub const HEAD_PREVIEW_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StreamEncoding {
    Utf8 { bom: bool },
    Utf16Le,
    Utf16Be,
}

impl StreamEncoding {
    pub fn encoding(self) -> &'static str {
        match self {
            Self::Utf8 { .. } => "utf-8",
            Self::Utf16Le => "utf-16le",
            Self::Utf16Be => "utf-16be",
        }
    }

    pub fn bom(self) -> &'static str {
        match self {
            Self::Utf8 { bom: true } => "utf8",
            Self::Utf8 { bom: false } => "none",
            Self::Utf16Le => "utf16le",
            Self::Utf16Be => "utf16be",
        }
    }

    fn bom_len(self) -> usize {
        match self {
            Self::Utf8 { bom: true } => 3,
            Self::Utf16Le | Self::Utf16Be => 2,
            Self::Utf8 { bom: false } => 0,
        }
    }
}

#[derive(Debug, Clone, Copy, Default)]
pub struct NewlineStats {
    pub has_lf: bool,
    pub has_crlf: bool,
    pub has_cr: bool,
}

pub struct StreamSnapshot {
    pub file: File,
    pub path: PathBuf,
    pub identity: FileIdentity,
    pub metadata: FileMetadata,
    pub prefix: Vec<u8>,
    pub encoding: StreamEncoding,
    pub newlines: NewlineStats,
    pub window_start: u64,
    pub window: Vec<u8>,
}

pub struct DecodedWindow {
    pub byte_start: u64,
    pub byte_end: u64,
    pub text: String,
}

// Hash the full authorized object with a fixed buffer; retain only the requested bounded window.
pub fn read_stream_snapshot(
    file: File,
    limit: u64,
    window: Range<u64>,
) -> Result<StreamSnapshot, AppError> {
    read_stream_snapshot_observed(file, limit, window, |_| Ok(()))
}

fn read_stream_snapshot_observed(
    file: File,
    limit: u64,
    window: Range<u64>,
    after_read: impl FnMut(u64) -> Result<(), AppError>,
) -> Result<StreamSnapshot, AppError> {
    read_stream_snapshot_validated(file, limit, window, true, after_read)
}

// Explicit diagnostic previews may show invalid text, but retain the same bounded
// window, full-object revision and concurrent-change checks as ordinary reads.
pub(super) fn read_raw_preview_window(
    file: File,
    window: Range<u64>,
) -> Result<StreamSnapshot, AppError> {
    read_stream_snapshot_validated(file, u64::MAX, window, false, |_| Ok(()))
}

fn read_stream_snapshot_validated(
    mut file: File,
    limit: u64,
    window: Range<u64>,
    strict_text: bool,
    mut after_read: impl FnMut(u64) -> Result<(), AppError>,
) -> Result<StreamSnapshot, AppError> {
    if window.end < window.start || window.end - window.start > MAX_WINDOW_BYTES {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "读取窗口超过上限或范围无效。",
        ));
    }
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let path = opened_file_path(&file)?;
    let before = file.metadata().map_err(io_error)?;
    if before.len() > limit {
        return Err(AppError::new(
            ErrorCode::TooLarge,
            "文件超过当前读取模式的大小限制。",
        ));
    }
    if window.start > before.len() {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "读取起点超出文件范围。",
        ));
    }
    let identity = identify(&file, &path);
    let mut hash = Sha256::new();
    hash.update(identity.revision_tag());
    let mut prefix = vec![0; before.len().min(4) as usize];
    file.read_exact(&mut prefix).map_err(io_error)?;
    let encoding = detect_encoding(&prefix);
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let mut validator = StreamValidator::new(encoding);
    let validate_text = strict_text && window.end > window.start;
    let mut bom_remaining = encoding.bom_len();
    let mut retained = Vec::with_capacity((window.end.min(before.len()) - window.start) as usize);
    let mut buffer = [0u8; 64 * 1024];
    let mut count = 0u64;
    loop {
        let capacity =
            (limit.saturating_sub(count).saturating_add(1)).min(buffer.len() as u64) as usize;
        let read = file.read(&mut buffer[..capacity]).map_err(io_error)?;
        if read == 0 {
            break;
        }
        let end = count + read as u64;
        if end > limit {
            return Err(AppError::new(
                ErrorCode::TooLarge,
                "读取期间文件超过当前模式的上限。",
            ));
        }
        hash.update(&buffer[..read]);
        let mut content = &buffer[..read];
        if bom_remaining > 0 {
            let skipped = bom_remaining.min(content.len());
            content = &content[skipped..];
            bom_remaining -= skipped;
        }
        if validate_text {
            validator.feed(content)?;
        }
        let start_in_window = window.start.max(count);
        let end_in_window = window.end.min(end);
        if start_in_window < end_in_window {
            retained.extend_from_slice(
                &buffer[(start_in_window - count) as usize..(end_in_window - count) as usize],
            );
        }
        count = end;
        after_read(count)?;
    }
    if validate_text {
        validator.finish()?;
        if validator.has_nul || validator.controls > validator.characters / 100 {
            return Err(AppError::new(
                ErrorCode::IsBinary,
                "文件可能是二进制，无法作为文本读取。",
            ));
        }
    }
    let after = file.metadata().map_err(io_error)?;
    if count != before.len()
        || after.len() != before.len()
        || before.modified().map_err(io_error)? != after.modified().map_err(io_error)?
        || opened_file_path(&file)? != path
    {
        return Err(AppError::new(
            ErrorCode::Conflict,
            "读取期间文件已变化，请重新打开。",
        ));
    }
    let metadata = finish_metadata(&path, &before, hash)?;
    Ok(StreamSnapshot {
        file,
        path,
        identity,
        metadata,
        prefix,
        encoding,
        newlines: validator.newlines,
        window_start: window.start,
        window: retained,
    })
}

pub fn decode_window(
    snapshot: &StreamSnapshot,
    requested_start: u64,
    max_bytes: u64,
) -> Result<DecodedWindow, AppError> {
    if max_bytes == 0 || max_bytes > MAX_CHUNK_BYTES {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "分块读取大小必须在1字节到1MiB之间。",
        ));
    }
    let total = snapshot.metadata.size_bytes;
    if requested_start > total || requested_start < snapshot.window_start {
        return Err(AppError::new(ErrorCode::InvalidInput, "分块起点无效。"));
    }
    let raw_end = snapshot.window_start + snapshot.window.len() as u64;
    let (start, mut end) = match snapshot.encoding {
        StreamEncoding::Utf8 { bom } => {
            let start = if requested_start == 0 {
                bom as u64 * 3
            } else {
                requested_start
            };
            (start, total.min(start.saturating_add(max_bytes)))
        }
        StreamEncoding::Utf16Le | StreamEncoding::Utf16Be => {
            let start = if requested_start == 0 {
                2
            } else if requested_start.is_multiple_of(2) {
                requested_start
            } else {
                requested_start + 1
            };
            let decoded_end = total.min(start.saturating_add(max_bytes));
            (start, decoded_end - (decoded_end - start) % 2)
        }
    };
    if end > raw_end {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "读取窗口不足以返回完整编码边界。",
        ));
    }
    let start_index = (start - snapshot.window_start) as usize;
    let mut end_index = (end - snapshot.window_start) as usize;
    let text = match snapshot.encoding {
        StreamEncoding::Utf8 { .. } => {
            if start_index < end_index
                && std::str::from_utf8(&snapshot.window[start_index..end_index])
                    .is_err_and(|error| error.valid_up_to() == 0)
            {
                return Err(AppError::new(
                    ErrorCode::EncodingRequired,
                    "分块起点不在UTF-8字符边界。",
                ));
            }
            match std::str::from_utf8(&snapshot.window[start_index..end_index]) {
                Ok(text) => text.to_owned(),
                Err(error) if error.error_len().is_none() => {
                    end_index = start_index + error.valid_up_to();
                    end = snapshot.window_start + end_index as u64;
                    std::str::from_utf8(&snapshot.window[start_index..end_index])
                        .expect("validated UTF-8 prefix")
                        .to_owned()
                }
                Err(_) => {
                    return Err(AppError::new(
                        ErrorCode::EncodingRequired,
                        "无法按UTF-8读取分块。",
                    ))
                }
            }
        }
        StreamEncoding::Utf16Le | StreamEncoding::Utf16Be => {
            let little = snapshot.encoding == StreamEncoding::Utf16Le;
            let mut units = snapshot.window[start_index..end_index]
                .as_chunks::<2>()
                .0
                .iter()
                .map(|[first, second]| {
                    if little {
                        u16::from_le_bytes([*first, *second])
                    } else {
                        u16::from_be_bytes([*first, *second])
                    }
                })
                .collect::<Vec<_>>();
            if units
                .last()
                .is_some_and(|unit| (0xd800..=0xdbff).contains(unit))
                && end < total
            {
                units.pop();
                end -= 2;
            }
            String::from_utf16(&units)
                .map_err(|_| AppError::new(ErrorCode::LossyEncoding, "无法无损读取UTF-16分块。"))?
        }
    };
    let (text, _) = normalize_newlines(&text);
    Ok(DecodedWindow {
        byte_start: start,
        byte_end: end,
        text,
    })
}

pub fn line_number_at(
    mut file: File,
    byte_offset: u64,
    encoding: StreamEncoding,
) -> Result<u64, AppError> {
    let size = file.metadata().map_err(io_error)?.len();
    if byte_offset > size {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "行号位置超出文件范围。",
        ));
    }
    file.seek(SeekFrom::Start(0)).map_err(io_error)?;
    let mut remaining = byte_offset;
    let mut first = true;
    let mut previous_cr = false;
    let mut lines = 1u64;
    let mut buffer = [0u8; 64 * 1024];
    while remaining > 0 {
        let mut length = remaining.min(buffer.len() as u64) as usize;
        if matches!(encoding, StreamEncoding::Utf16Le | StreamEncoding::Utf16Be) {
            length -= length % 2;
            if length == 0 {
                break;
            }
        }
        file.read_exact(&mut buffer[..length]).map_err(io_error)?;
        remaining -= length as u64;
        let mut bytes = &buffer[..length];
        if first {
            bytes = bytes
                .strip_prefix(match encoding {
                    StreamEncoding::Utf8 { bom: true } => &[0xef, 0xbb, 0xbf][..],
                    StreamEncoding::Utf16Le => &[0xff, 0xfe][..],
                    StreamEncoding::Utf16Be => &[0xfe, 0xff][..],
                    StreamEncoding::Utf8 { bom: false } => &[][..],
                })
                .unwrap_or(bytes);
            first = false;
        }
        match encoding {
            StreamEncoding::Utf8 { .. } => {
                for byte in bytes {
                    count_newline_byte(*byte, &mut previous_cr, &mut lines);
                }
            }
            StreamEncoding::Utf16Le | StreamEncoding::Utf16Be => {
                let little = encoding == StreamEncoding::Utf16Le;
                for [first, second] in bytes.as_chunks::<2>().0 {
                    let unit = if little {
                        u16::from_le_bytes([*first, *second])
                    } else {
                        u16::from_be_bytes([*first, *second])
                    };
                    count_newline_unit(unit, &mut previous_cr, &mut lines);
                }
            }
        }
    }
    if previous_cr {
        lines += 1;
    }
    Ok(lines)
}

fn detect_encoding(prefix: &[u8]) -> StreamEncoding {
    if prefix.starts_with(&[0xff, 0xfe]) {
        StreamEncoding::Utf16Le
    } else if prefix.starts_with(&[0xfe, 0xff]) {
        StreamEncoding::Utf16Be
    } else {
        StreamEncoding::Utf8 {
            bom: prefix.starts_with(&[0xef, 0xbb, 0xbf]),
        }
    }
}

struct StreamValidator {
    encoding: StreamEncoding,
    pending: Vec<u8>,
    pending_unit: Option<u16>,
    characters: u64,
    controls: u64,
    has_nul: bool,
    previous_cr: bool,
    newlines: NewlineStats,
}

impl StreamValidator {
    fn new(encoding: StreamEncoding) -> Self {
        Self {
            encoding,
            pending: Vec::with_capacity(4),
            pending_unit: None,
            characters: 0,
            controls: 0,
            has_nul: false,
            previous_cr: false,
            newlines: NewlineStats::default(),
        }
    }

    fn feed(&mut self, bytes: &[u8]) -> Result<(), AppError> {
        self.pending.extend_from_slice(bytes);
        match self.encoding {
            StreamEncoding::Utf8 { .. } => self.feed_utf8(),
            StreamEncoding::Utf16Le | StreamEncoding::Utf16Be => self.feed_utf16(),
        }
    }

    fn feed_utf8(&mut self) -> Result<(), AppError> {
        match std::str::from_utf8(&self.pending) {
            Ok(source) => {
                let source = source.to_owned();
                self.consume(source.chars());
                self.pending.clear();
                Ok(())
            }
            Err(error) if error.error_len().is_some() => Err(AppError::new(
                ErrorCode::EncodingRequired,
                "无法按UTF-8读取，请选择合适的编码。",
            )),
            Err(error) => {
                let valid = error.valid_up_to();
                let source = std::str::from_utf8(&self.pending[..valid]).expect("validated UTF-8");
                let source = source.to_owned();
                self.consume(source.chars());
                self.pending.drain(..valid);
                Ok(())
            }
        }
    }

    fn feed_utf16(&mut self) -> Result<(), AppError> {
        let little = self.encoding == StreamEncoding::Utf16Le;
        let pair_count = self.pending.len() / 2;
        let units = self.pending[..pair_count * 2]
            .as_chunks::<2>()
            .0
            .iter()
            .map(|[first, second]| {
                if little {
                    u16::from_le_bytes([*first, *second])
                } else {
                    u16::from_be_bytes([*first, *second])
                }
            })
            .collect::<Vec<_>>();
        self.pending.drain(..pair_count * 2);
        for unit in units {
            if let Some(high) = self.pending_unit.take() {
                if !(0xdc00..=0xdfff).contains(&unit) {
                    return Err(invalid_utf16());
                }
                let scalar = 0x10000 + (((high as u32 - 0xd800) << 10) | (unit as u32 - 0xdc00));
                let character = char::from_u32(scalar).ok_or_else(invalid_utf16)?;
                self.consume_one(character);
            } else if (0xdc00..=0xdfff).contains(&unit) {
                return Err(invalid_utf16());
            } else if (0xd800..=0xdbff).contains(&unit) {
                self.pending_unit = Some(unit);
            } else {
                let character = char::from_u32(unit as u32).ok_or_else(invalid_utf16)?;
                self.consume_one(character);
            }
        }
        Ok(())
    }

    fn finish(&mut self) -> Result<(), AppError> {
        if !self.pending.is_empty() || self.pending_unit.is_some() {
            return Err(if matches!(self.encoding, StreamEncoding::Utf8 { .. }) {
                AppError::new(
                    ErrorCode::EncodingRequired,
                    "无法按UTF-8读取，请选择合适的编码。",
                )
            } else {
                invalid_utf16()
            });
        }
        if self.previous_cr {
            self.newlines.has_cr = true;
        }
        Ok(())
    }

    fn consume(&mut self, characters: impl Iterator<Item = char>) {
        for character in characters {
            self.consume_one(character);
        }
    }

    fn consume_one(&mut self, character: char) {
        self.characters += 1;
        if character == '\0' {
            self.has_nul = true;
        } else if character.is_control() && !matches!(character, '\r' | '\n' | '\t') {
            self.controls += 1;
        }
        match character {
            '\r' => {
                if self.previous_cr {
                    self.newlines.has_cr = true;
                }
                self.previous_cr = true;
            }
            '\n' => {
                if self.previous_cr {
                    self.newlines.has_crlf = true;
                } else {
                    self.newlines.has_lf = true;
                }
                self.previous_cr = false;
            }
            _ => {
                if self.previous_cr {
                    self.newlines.has_cr = true;
                    self.previous_cr = false;
                }
            }
        }
    }
}

fn count_newline_byte(byte: u8, previous_cr: &mut bool, lines: &mut u64) {
    match byte {
        b'\r' => {
            if *previous_cr {
                *lines += 1;
            }
            *previous_cr = true;
        }
        b'\n' => {
            *lines += 1;
            *previous_cr = false;
        }
        _ => {
            if *previous_cr {
                *lines += 1;
                *previous_cr = false;
            }
        }
    }
}

fn count_newline_unit(unit: u16, previous_cr: &mut bool, lines: &mut u64) {
    match unit {
        0x000d => {
            if *previous_cr {
                *lines += 1;
            }
            *previous_cr = true;
        }
        0x000a => {
            *lines += 1;
            *previous_cr = false;
        }
        _ => {
            if *previous_cr {
                *lines += 1;
                *previous_cr = false;
            }
        }
    }
}

fn invalid_utf16() -> AppError {
    AppError::new(
        ErrorCode::LossyEncoding,
        "无法无损读取UTF-16，请检查文件编码。",
    )
}

#[cfg(test)]
mod tests {
    use super::read_stream_snapshot_observed;
    use crate::{
        models::ErrorCode,
        services::{
            open_policy::{CHUNKED_THRESHOLD, FULL_READ_LIMIT},
            save::MAX_FILE_BYTES,
        },
    };
    use std::{
        fs::{self, File, OpenOptions},
        io::Write,
        path::PathBuf,
    };

    fn fixture(size: u64) -> PathBuf {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap()
            .join(".artifacts/T103/dynamic-growth")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&root).unwrap();
        let path = root.join("growing.txt");
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        file.set_len(size).unwrap();
        path
    }

    fn append(path: &PathBuf, bytes: &[u8]) {
        let mut file = OpenOptions::new().append(true).open(path).unwrap();
        file.write_all(bytes).unwrap();
        file.sync_all().unwrap();
    }

    #[test]
    fn concurrent_growth_across_twenty_and_hundred_mib_limits_is_rejected() {
        for (initial, appended, limit) in [
            (
                CHUNKED_THRESHOLD - 128 * 1024,
                128 * 1024 + 1,
                CHUNKED_THRESHOLD - 1,
            ),
            (FULL_READ_LIMIT - 128 * 1024, 128 * 1024 + 1, MAX_FILE_BYTES),
        ] {
            let path = fixture(initial);
            let mut grew = false;
            let result =
                read_stream_snapshot_observed(File::open(&path).unwrap(), limit, 0..0, |count| {
                    if !grew && count > 0 {
                        grew = true;
                        append(&path, &vec![b'x'; appended as usize]);
                    }
                    Ok(())
                });
            assert!(grew);
            assert_eq!(result.err().unwrap().code, ErrorCode::TooLarge);
        }
    }

    #[test]
    fn concurrent_growth_below_the_limit_is_a_revision_conflict() {
        let path = fixture(1024 * 1024);
        let mut grew = false;
        let result = read_stream_snapshot_observed(
            File::open(&path).unwrap(),
            CHUNKED_THRESHOLD - 1,
            0..0,
            |count| {
                if !grew && count > 0 {
                    grew = true;
                    append(&path, b"x");
                }
                Ok(())
            },
        );
        assert!(grew);
        assert_eq!(result.err().unwrap().code, ErrorCode::Conflict);
    }
}
