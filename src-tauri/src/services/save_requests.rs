use super::{
    files::FileService,
    save::{HardLinkPolicy, PreparedSave, MAX_SNAPSHOT_BYTES},
    snapshot::read_snapshot,
};
use crate::models::{
    AppError, ErrorCode, FileMetadata, SaveAck, SaveAsAck, SaveAsRequest, SaveRequest,
};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, VecDeque},
    io::Write,
    path::Path,
    sync::{Arc, Mutex},
};

type Key = (String, String);
type Outcome = Result<SaveAck, AppError>;
type AsOutcome = Result<SaveAsAck, AppError>;
#[derive(Clone)]
enum SavedValue {
    Existing(SaveAck),
    Destination(SaveAsAck),
}
#[derive(Default)]
pub struct SaveHistory {
    results: HashMap<Key, (String, Result<SavedValue, AppError>)>,
    order: VecDeque<Key>,
}

#[derive(Default)]
pub struct InFlightSaves {
    requests: Mutex<HashMap<Key, String>>,
}
pub struct SavePermit {
    owner: Arc<InFlightSaves>,
    key: Key,
}

pub struct SaveAsTicket {
    key: Key,
    hash: String,
}
pub enum SaveAsStart {
    Replay(AsOutcome),
    Fresh(SaveAsTicket),
}

impl InFlightSaves {
    pub fn enter(self: &Arc<Self>, request: &SaveRequest) -> Result<SavePermit, AppError> {
        let hash = payload_hash(request)?;
        let key = (request.document_id.clone(), request.request_id.clone());
        self.enter_hash(key, hash)
    }

    pub fn enter_as(self: &Arc<Self>, request: &SaveAsRequest) -> Result<SavePermit, AppError> {
        self.enter_hash(
            (request.document_id.clone(), request.request_id.clone()),
            as_hash(request)?,
        )
    }

    fn enter_hash(self: &Arc<Self>, key: Key, hash: String) -> Result<SavePermit, AppError> {
        let mut requests = self.requests.lock().map_err(|_| internal())?;
        if let Some(previous) = requests.get(&key) {
            return Err(if previous == &hash {
                AppError::new(ErrorCode::Busy, "此保存请求仍在处理中，请等待。")
            } else {
                reused_id()
            });
        }
        requests.insert(key.clone(), hash);
        Ok(SavePermit {
            owner: self.clone(),
            key,
        })
    }
}

impl Drop for SavePermit {
    fn drop(&mut self) {
        if let Ok(mut requests) = self.owner.requests.lock() {
            requests.remove(&self.key);
        }
    }
}

impl FileService {
    pub fn save_existing(
        &mut self,
        request: SaveRequest,
        journal_root: &Path,
        policy: HardLinkPolicy,
    ) -> Outcome {
        let hash = payload_hash(&request)?;
        let key = (request.document_id.clone(), request.request_id.clone());
        if let Some((previous, result)) = self.saves.results.get(&key) {
            return if *previous == hash {
                match result.clone() {
                    Ok(SavedValue::Existing(ack)) => Ok(ack),
                    Err(error) => Err(error),
                    _ => Err(reused_id()),
                }
            } else {
                Err(reused_id())
            };
        }
        let result = PreparedSave::prepare(self, request, journal_root, policy)
            .and_then(|prepared| prepared.commit(self));
        self.saves
            .remember(key, hash, result.clone().map(SavedValue::Existing));
        result
    }

    pub fn begin_save_as(&self, request: &SaveAsRequest) -> Result<SaveAsStart, AppError> {
        let hash = as_hash(request)?;
        let key = (request.document_id.clone(), request.request_id.clone());
        if let Some((previous, result)) = self.saves.results.get(&key) {
            if *previous != hash {
                return Err(reused_id());
            }
            let result = match result.clone() {
                Ok(SavedValue::Destination(ack)) => Ok(ack),
                Err(error) => Err(error),
                _ => Err(reused_id()),
            };
            return Ok(SaveAsStart::Replay(result));
        }
        Ok(SaveAsStart::Fresh(SaveAsTicket { key, hash }))
    }

    pub fn finish_save_as(&mut self, ticket: SaveAsTicket, result: AsOutcome) -> AsOutcome {
        self.saves.remember(
            ticket.key,
            ticket.hash,
            result.clone().map(SavedValue::Destination),
        );
        result
    }

    pub fn stat_document(&self, id: &str) -> Result<FileMetadata, AppError> {
        let document = self
            .documents
            .get(id)
            .ok_or_else(|| AppError::new(ErrorCode::NotFound, "此文档未打开。"))?;
        let (file, _) = self.grants.open_file(&document.reference)?;
        Ok(read_snapshot(file, super::save::MAX_FILE_BYTES)?.metadata)
    }
}

impl SaveHistory {
    fn remember(&mut self, key: Key, hash: String, value: Result<SavedValue, AppError>) {
        if !self.results.contains_key(&key) {
            self.order.push_back(key.clone());
        }
        self.results.insert(key, (hash, value));
        while self.order.len() > 512 {
            if let Some(expired) = self.order.pop_front() {
                self.results.remove(&expired);
            }
        }
    }
}

fn as_hash(request: &SaveAsRequest) -> Result<String, AppError> {
    if uuid::Uuid::parse_str(&request.document_id).is_err()
        || uuid::Uuid::parse_str(&request.request_id).is_err()
        || request.document_version > 9_007_199_254_740_991
        || request.format.encoding.len() > 64
        || request.format.bom.len() > 16
        || request.format.line_ending.len() > 16
        || request
            .newline_map
            .as_ref()
            .is_some_and(|map| map.endings.len() > request.text.len())
    {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "另存快照格式或长度无效。",
        ));
    }
    if request.text.len() > MAX_SNAPSHOT_BYTES {
        return Err(AppError::new(
            ErrorCode::TooLarge,
            "保存快照超过64MiB限制。",
        ));
    }
    fingerprint(request)
}

fn payload_hash(request: &SaveRequest) -> Result<String, AppError> {
    if request.document_id.is_empty()
        || request.document_id.len() > 128
        || uuid::Uuid::parse_str(&request.request_id).is_err()
        || request.expected_disk_revision.len() != 64
        || !request
            .expected_disk_revision
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit())
        || request.format.encoding.len() > 64
        || request.format.bom.len() > 16
        || request.format.line_ending.len() > 16
        || request
            .newline_map
            .as_ref()
            .is_some_and(|map| map.endings.len() > request.text.len())
    {
        return Err(AppError::new(
            ErrorCode::InvalidInput,
            "保存请求格式或长度无效。",
        ));
    }
    if request.text.len() > MAX_SNAPSHOT_BYTES {
        return Err(AppError::new(
            ErrorCode::TooLarge,
            "保存快照超过64MiB限制。",
        ));
    }
    fingerprint(request)
}

fn fingerprint(request: &impl serde::Serialize) -> Result<String, AppError> {
    struct HashWriter(Sha256);
    impl Write for HashWriter {
        fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
            self.0.update(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    let mut writer = HashWriter(Sha256::new());
    serde_json::to_writer(&mut writer, request).map_err(|_| internal())?;
    Ok(format!("{:x}", writer.0.finalize()))
}

fn reused_id() -> AppError {
    AppError::new(
        ErrorCode::InvalidInput,
        "同一保存请求标识不能用于不同快照。",
    )
}
fn internal() -> AppError {
    AppError::new(ErrorCode::Internal, "保存请求服务暂时不可用。")
}
