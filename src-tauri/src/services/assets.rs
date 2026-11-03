use super::{files::FileService, grants::opened_file_path, windows_file};
use crate::models::{io_error, AppError, ErrorCode, FileRef};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::{fs::File, io::Read, path::PathBuf};

pub const MAX_IMAGE_BYTES: u64 = 20 * 1024 * 1024;
const MAX_IMAGE_PIXELS: usize = 40_000_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceRequest {
    pub document_id: Option<String>,
    pub directory: Option<FileRef>,
    pub url: String,
    pub max_bytes: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceImage {
    pub mime: String,
    pub data_base64: String,
    pub size_bytes: u64,
    pub width: Option<usize>,
    pub height: Option<usize>,
}

struct ScopedResource {
    file: File,
    path: PathBuf,
    root: PathBuf,
    _guards: Vec<File>,
}

fn invalid() -> AppError {
    AppError::new(ErrorCode::InvalidInput, "图片资源请求无效。")
}
fn outside() -> AppError {
    AppError::new(
        ErrorCode::OutOfScope,
        "资源不在文档目录或已授权范围内，请显式授权目录。",
    )
}

pub fn decode_resource_path(url: &str) -> Result<PathBuf, AppError> {
    if url.len() > 32_767 || url.chars().any(char::is_control) {
        return Err(invalid());
    }
    let path = url.split(['#', '?']).next().unwrap_or_default();
    let decoded = percent_encoding::percent_decode_str(path)
        .decode_utf8()
        .map_err(|_| invalid())?
        .replace('\\', "/");
    if decoded.is_empty()
        || decoded.starts_with('/')
        || decoded.contains(':')
        || decoded.chars().any(char::is_control)
        || ["%2e", "%2f", "%5c", "%00", "%3a"]
            .iter()
            .any(|control| decoded.to_ascii_lowercase().contains(control))
    {
        return Err(outside());
    }
    Ok(PathBuf::from(decoded))
}

pub fn inspect_resource_image(bytes: &[u8], limit: u64) -> Result<ResourceImage, AppError> {
    if bytes.len() as u64 > limit.min(MAX_IMAGE_BYTES) {
        return Err(AppError::new(
            ErrorCode::TooLarge,
            "图片超过单资源或剩余嵌入预算。",
        ));
    }
    let mime = match imagesize::image_type(bytes) {
        Ok(imagesize::ImageType::Png) => "image/png",
        Ok(imagesize::ImageType::Jpeg) => "image/jpeg",
        Ok(imagesize::ImageType::Gif) => "image/gif",
        Ok(imagesize::ImageType::Webp) => "image/webp",
        _ if std::str::from_utf8(bytes).ok().is_some_and(|text| {
            text.trim_start_matches('\u{feff}')
                .trim_start()
                .starts_with('<')
                && text.contains("<svg")
        }) =>
        {
            "image/svg+xml"
        }
        _ => {
            return Err(AppError::new(
                ErrorCode::Unsupported,
                "资源不是支持的安全图片格式。",
            ))
        }
    };
    let dimensions = if mime == "image/svg+xml" {
        None // The host must sanitize SVG and verify its viewport before use.
    } else {
        let size = imagesize::blob_size(bytes).map_err(|_| invalid())?;
        if size.width == 0
            || size.height == 0
            || size
                .width
                .checked_mul(size.height)
                .is_none_or(|pixels| pixels > MAX_IMAGE_PIXELS)
        {
            return Err(AppError::new(
                ErrorCode::TooLarge,
                "图片尺寸超过40MP安全上限。",
            ));
        }
        Some(size)
    };
    Ok(ResourceImage {
        mime: mime.into(),
        data_base64: STANDARD.encode(bytes),
        size_bytes: bytes.len() as u64,
        width: dimensions.as_ref().map(|size| size.width),
        height: dimensions.map(|size| size.height),
    })
}

impl FileService {
    pub fn read_preview_resource(
        &self,
        request: ResourceRequest,
    ) -> Result<ResourceImage, AppError> {
        if request.max_bytes == 0 || request.max_bytes > MAX_IMAGE_BYTES {
            return Err(invalid());
        }
        if request.url.starts_with("data:") {
            if request.url.len() > 28 * 1024 * 1024 {
                return Err(invalid());
            }
            let (header, encoded) = request.url.split_once(',').ok_or_else(invalid)?;
            if ![
                "data:image/png;base64",
                "data:image/jpeg;base64",
                "data:image/gif;base64",
                "data:image/webp;base64",
                "data:image/svg+xml;base64",
            ]
            .contains(&header)
            {
                return Err(invalid());
            }
            let bytes = STANDARD.decode(encoded).map_err(|_| invalid())?;
            let image = inspect_resource_image(&bytes, request.max_bytes)?;
            if header != format!("data:{};base64", image.mime) {
                return Err(invalid());
            }
            return Ok(image);
        }
        let resource = self.open_resource_file(
            request.document_id.as_deref(),
            request.directory.as_ref(),
            &request.url,
        )?;
        let metadata = resource.file.metadata().map_err(io_error)?;
        if metadata.len() > request.max_bytes {
            return Err(AppError::new(ErrorCode::TooLarge, "图片超过剩余嵌入预算。"));
        }
        let mut bytes = Vec::new();
        resource
            .file
            .take(request.max_bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        inspect_resource_image(&bytes, request.max_bytes)
    }

    pub fn authorize_preview_link(
        &mut self,
        document_id: Option<&str>,
        directory: Option<&FileRef>,
        url: &str,
    ) -> Result<FileRef, AppError> {
        let resource = self.open_resource_file(document_id, directory, url)?;
        self.grants
            .pin_resource_file(&resource.file, &resource.path, &resource.root)
    }

    fn open_resource_file(
        &self,
        document_id: Option<&str>,
        directory: Option<&FileRef>,
        url: &str,
    ) -> Result<ScopedResource, AppError> {
        let relative = decode_resource_path(url)?;
        let mut roots = Vec::new();
        let base = if let Some(id) = document_id {
            let lease = self.document_lease(id).ok_or_else(outside)?;
            let base = lease.path.parent().ok_or_else(outside)?.to_path_buf();
            roots.push(base.clone());
            if let Ok(root) = self.grants.resolve_directory(&FileRef {
                grant_id: lease.reference.grant_id.clone(),
                relative_path: String::new(),
            }) {
                roots.push(root);
            }
            base
        } else if let Some(directory) = directory {
            self.grants.resolve_directory(directory)?
        } else {
            return Err(outside());
        };
        if let Some(directory) = directory {
            roots.push(self.grants.resolve_directory(directory)?);
        }
        let canonical = base.join(relative).canonicalize().map_err(io_error)?;
        let root = roots
            .iter()
            .find(|root| canonical.starts_with(root))
            .ok_or_else(outside)?;
        let mut guards = vec![windows_file::lock_directory(root)?];
        guards.extend(windows_file::lock_parent_chain(&canonical)?);
        let file = File::open(&canonical).map_err(io_error)?;
        let final_path = opened_file_path(&file)?;
        if !final_path.starts_with(root) || !windows_file::same_path(&final_path, &canonical) {
            return Err(outside());
        }
        let metadata = file.metadata().map_err(io_error)?;
        if !metadata.is_file() {
            return Err(AppError::new(ErrorCode::InvalidInput, "资源不是普通文件。"));
        }
        Ok(ScopedResource {
            file,
            path: final_path,
            root: root.clone(),
            _guards: guards,
        })
    }
}
