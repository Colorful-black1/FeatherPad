pub const NORMAL_LIMIT: u64 = 2 * 1024 * 1024;
pub const CHUNKED_THRESHOLD: u64 = 20 * 1024 * 1024;
pub const FULL_READ_LIMIT: u64 = 100 * 1024 * 1024;
pub const LONG_LINE_CHARACTERS: usize = 100_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OpenPolicy {
    Normal,
    Degraded,
    LargeReadOnly,
    HeadPreviewOnly,
}

impl OpenPolicy {
    pub fn for_size(bytes: u64) -> Self {
        if bytes <= NORMAL_LIMIT {
            Self::Normal
        } else if bytes < CHUNKED_THRESHOLD {
            Self::Degraded
        } else if bytes <= FULL_READ_LIMIT {
            Self::LargeReadOnly
        } else {
            Self::HeadPreviewOnly
        }
    }

    pub fn editable_read_limit(self) -> Option<u64> {
        match self {
            Self::Normal | Self::Degraded => Some(CHUNKED_THRESHOLD - 1),
            Self::LargeReadOnly | Self::HeadPreviewOnly => None,
        }
    }
}

pub fn has_long_line(source: &str) -> bool {
    let mut length = 0;
    for character in source.chars() {
        if matches!(character, '\r' | '\n') {
            length = 0;
        } else {
            length += 1;
            if length > LONG_LINE_CHARACTERS {
                return true;
            }
        }
    }
    false
}
