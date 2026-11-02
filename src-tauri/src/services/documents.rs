use super::identity::FileIdentity;
use crate::models::{AppError, ErrorCode, FileRef, RenamedDocument};
use std::{
    collections::{HashMap, HashSet},
    fs::File,
    path::{Component, Path, PathBuf},
};

pub struct DocumentLease {
    pub identity: FileIdentity,
    pub reference: FileRef,
    pub path: PathBuf,
    pub file: File,
}

#[derive(Clone)]
pub(super) struct DetachedDocument {
    pub id: String,
    pub identity: FileIdentity,
    pub path: PathBuf,
    pub reference: FileRef,
}

#[derive(Default)]
pub struct DocumentRegistry {
    identities: HashMap<FileIdentity, String>,
    documents: HashMap<String, DocumentLease>,
    fragment_documents: HashSet<String>,
    chunk_handles: HashMap<String, String>,
}

impl DocumentRegistry {
    pub fn owner_of(&self, identity: &FileIdentity) -> Option<&str> {
        self.identities.get(identity).map(String::as_str)
    }

    pub fn owner_at(&self, path: &std::path::Path) -> Option<&str> {
        self.documents.iter().find_map(|(id, document)| {
            (document.path == path || document.path.canonicalize().ok().as_deref() == Some(path))
                .then_some(id.as_str())
        })
    }
    pub fn register(&mut self, lease: DocumentLease) -> String {
        if let Some(id) = self.identities.get(&lease.identity) {
            return id.clone();
        }
        let id = uuid::Uuid::new_v4().to_string();
        self.identities.insert(lease.identity.clone(), id.clone());
        self.documents.insert(id.clone(), lease);
        id
    }

    pub fn mark_fragment(&mut self, id: &str) {
        if self.documents.contains_key(id) {
            self.fragment_documents.insert(id.to_owned());
        }
    }

    pub fn is_fragment(&self, id: &str) -> bool {
        self.fragment_documents.contains(id)
    }

    pub fn issue_chunk_handle(&mut self, id: &str) -> Option<String> {
        if !self.documents.contains_key(id) {
            return None;
        }
        let handle = uuid::Uuid::new_v4().to_string();
        self.chunk_handles.insert(handle.clone(), id.to_owned());
        Some(handle)
    }

    pub fn chunk_document(&self, handle: &str) -> Option<&str> {
        self.chunk_handles.get(handle).map(String::as_str)
    }

    pub fn get(&self, id: &str) -> Option<&DocumentLease> {
        self.documents.get(id)
    }

    pub(super) fn release(&mut self, id: &str) -> bool {
        let document = self.documents.remove(id);
        if let Some(document) = &document {
            self.identities.remove(&document.identity);
        }
        let was_fragment = self.fragment_documents.remove(id);
        let handles_before = self.chunk_handles.len();
        self.chunk_handles.retain(|_, owner| owner != id);
        document.is_some() || was_fragment || handles_before != self.chunk_handles.len()
    }

    pub(super) fn under<'a>(
        &'a self,
        root: &'a Path,
    ) -> impl Iterator<Item = (&'a str, &'a DocumentLease)> {
        self.documents
            .iter()
            .filter(move |(_, lease)| lease.path.starts_with(root))
            .map(|(id, lease)| (id.as_str(), lease))
    }

    pub fn rebase_under(
        &mut self,
        old_root: &Path,
        new_root: &Path,
        new_reference: &FileRef,
    ) -> Vec<RenamedDocument> {
        let mut renamed = Vec::new();
        for (document_id, document) in &mut self.documents {
            let Ok(suffix) = document.path.strip_prefix(old_root) else {
                continue;
            };
            let new_path = if suffix.as_os_str().is_empty() {
                new_root.to_path_buf()
            } else {
                new_root.join(suffix)
            };
            let mut relative_path = new_reference
                .relative_path
                .trim_end_matches(['/', '\\'])
                .to_owned();
            for component in suffix.components() {
                let Component::Normal(segment) = component else {
                    continue;
                };
                if !relative_path.is_empty() {
                    relative_path.push('/');
                }
                relative_path.push_str(&segment.to_string_lossy());
            }
            let reference = FileRef {
                grant_id: new_reference.grant_id.clone(),
                relative_path,
            };
            document.path = new_path.clone();
            document.reference = reference.clone();
            renamed.push(RenamedDocument {
                document_id: document_id.clone(),
                reference,
                display_path: new_path.to_string_lossy().into_owned(),
            });
        }
        renamed
    }

    pub(super) fn detach_under(&mut self, old_root: &Path) -> Vec<DetachedDocument> {
        let document_ids = self
            .documents
            .iter()
            .filter(|(_, document)| document.path.starts_with(old_root))
            .map(|(id, _)| id.clone())
            .collect::<Vec<_>>();
        let mut detached = Vec::with_capacity(document_ids.len());
        for id in document_ids {
            if let Some(document) = self.documents.remove(&id) {
                self.identities.remove(&document.identity);
                detached.push(DetachedDocument {
                    id,
                    identity: document.identity,
                    path: document.path,
                    reference: document.reference,
                });
            }
        }
        detached
    }

    pub(super) fn restore_all(
        &mut self,
        leases: Vec<(String, DocumentLease)>,
    ) -> Result<(), AppError> {
        let mut document_ids = HashSet::with_capacity(leases.len());
        let mut identities = HashSet::with_capacity(leases.len());
        for (id, lease) in &leases {
            if self.documents.contains_key(id)
                || self.identities.contains_key(&lease.identity)
                || !document_ids.insert(id)
                || !identities.insert(lease.identity.clone())
            {
                return Err(AppError::new(
                    ErrorCode::Conflict,
                    "目录改名期间已打开文档身份冲突，请刷新后重试。",
                ));
            }
        }
        for (id, lease) in leases {
            self.identities.insert(lease.identity.clone(), id.clone());
            self.documents.insert(id, lease);
        }
        Ok(())
    }

    pub fn replace(&mut self, id: &str, lease: DocumentLease) {
        if let Some(previous) = self.documents.insert(id.to_owned(), lease) {
            self.identities.remove(&previous.identity);
        }
        if let Some(document) = self.documents.get(id) {
            self.identities
                .insert(document.identity.clone(), id.to_owned());
        }
    }
}
