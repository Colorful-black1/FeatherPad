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
