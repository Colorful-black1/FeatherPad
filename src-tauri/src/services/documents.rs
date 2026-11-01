use super::identity::FileIdentity;
use crate::models::FileRef;
use std::{collections::HashMap, fs::File, path::PathBuf};

pub struct DocumentLease {
    pub identity: FileIdentity,
    pub reference: FileRef,
    pub path: PathBuf,
    pub file: File,
}

#[derive(Default)]
pub struct DocumentRegistry {
    identities: HashMap<FileIdentity, String>,
    documents: HashMap<String, DocumentLease>,
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

    pub fn get(&self, id: &str) -> Option<&DocumentLease> {
        self.documents.get(id)
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
