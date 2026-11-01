use std::{
    fs::File,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, Hash, PartialEq, Eq)]
pub enum FileIdentity {
    Windows { volume: u64, file_id: [u8; 16] },
    Canonical(PathBuf),
}

impl FileIdentity {
    pub fn revision_tag(&self) -> Vec<u8> {
        match self {
            Self::Windows { volume, file_id } => {
                let mut tag = vec![1];
                tag.extend_from_slice(&volume.to_le_bytes());
                tag.extend_from_slice(file_id);
                tag
            }
            Self::Canonical(path) => {
                let mut tag = vec![0];
                tag.extend_from_slice(path.as_os_str().as_encoded_bytes());
                tag
            }
        }
    }
}

#[cfg(windows)]
pub fn identify(file: &File, canonical: &Path) -> FileIdentity {
    use std::{
        mem::{size_of, MaybeUninit},
        os::windows::io::AsRawHandle,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FileIdInfo, GetFileInformationByHandleEx, FILE_ID_INFO,
    };
    let mut info = MaybeUninit::<FILE_ID_INFO>::zeroed();
    // SAFETY: live handle and correctly sized/aligned output; assume_init only on API success.
    let succeeded = unsafe {
        GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileIdInfo,
            info.as_mut_ptr().cast(),
            size_of::<FILE_ID_INFO>() as u32,
        )
    };
    if succeeded != 0 {
        // SAFETY: successful FileIdInfo fills the complete FILE_ID_INFO.
        let info = unsafe { info.assume_init() };
        FileIdentity::Windows {
            volume: info.VolumeSerialNumber,
            file_id: info.FileId.Identifier,
        }
    } else {
        FileIdentity::Canonical(canonical.to_owned())
    }
}

#[cfg(not(windows))]
pub fn identify(_file: &File, canonical: &Path) -> FileIdentity {
    FileIdentity::Canonical(canonical.to_owned())
}
