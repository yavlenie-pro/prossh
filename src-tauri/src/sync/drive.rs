//! Minimal Google Drive v3 client.
//!
//! We only need four operations on a single file that lives in the user's
//! "My Drive":
//!
//! - **find** a file by name, returning its `id` (so we can decide whether
//!   the next push is an upload or an update),
//! - **download** the bytes of that file by id,
//! - **create** a new file with given name + bytes,
//! - **update** the bytes of an existing file by id.
//!
//! We deliberately scope to `drive.file` rather than `drive`. `drive.file`
//! lets an app see only files it has itself created (or that the user has
//! explicitly picked through the Google Picker), which is the minimum
//! privilege for our use case and spares users the "this app wants to see
//! everything in your Drive" consent screen.
//!
//! Multipart uploads are used because the payloads we push are tiny (a few
//! hundred KiB at most) — resumable uploads would be overkill.
//!
//! Every function here takes a *fresh* access token. Refreshing is handled
//! one layer up in [`super`], so this module is a straightforward REST
//! wrapper with no state.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::AppError;

const DRIVE_FILES: &str = "https://www.googleapis.com/drive/v3/files";
const DRIVE_UPLOAD: &str = "https://www.googleapis.com/upload/drive/v3/files";

/// Minimal metadata about a Drive file. We never need owners, parents,
/// thumbnails etc. — just enough to decide what to do next.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FileMeta {
    pub id: String,
    pub name: String,
    /// RFC3339 timestamp of the last content modification. Displayed in the
    /// UI so the user can see "last synced 3 minutes ago".
    #[serde(rename = "modifiedTime")]
    pub modified_time: Option<String>,
    /// Size in bytes as a string (Drive's quirk — it's a 64-bit int that
    /// exceeds JS safe-integer range, so the API returns it as a string).
    pub size: Option<String>,
}

/// `files.list` response subset.
#[derive(Debug, Deserialize)]
struct ListResp {
    files: Vec<FileMeta>,
}

fn build_client() -> Result<reqwest::Client, AppError> {
    reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|e| AppError::Internal(format!("build reqwest: {e}")))
}

/// Turn a non-2xx reqwest response into a best-effort `AppError::Internal`
/// that includes the server's body — Drive error responses are JSON with a
/// `{"error":{"message":"…"}}` shape, which is much more useful to display
/// than "400 Bad Request".
async fn map_err(resp: reqwest::Response, context: &str) -> AppError {
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    AppError::Internal(format!("{context}: {status} {body}"))
}

/// Look up a file by exact name in the user's Drive root. Returns `None`
/// if nothing matches. If several files share the name we take the newest
/// (Drive returns results sorted by modifiedTime desc when we ask).
///
/// The `q` syntax is documented at
/// <https://developers.google.com/drive/api/guides/search-files>. We quote
/// the filename after escaping `'` and `\` — the only two characters that
/// are special inside Drive's single-quoted string literals.
pub async fn find_by_name(access_token: &str, name: &str) -> Result<Option<FileMeta>, AppError> {
    let escaped = name.replace('\\', "\\\\").replace('\'', "\\'");
    let q = format!("name = '{escaped}' and trashed = false");

    let client = build_client()?;
    let resp = client
        .get(DRIVE_FILES)
        .bearer_auth(access_token)
        .query(&[
            ("q", q.as_str()),
            ("fields", "files(id,name,modifiedTime,size)"),
            ("orderBy", "modifiedTime desc"),
            ("pageSize", "10"),
            ("spaces", "drive"),
        ])
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("drive.files.list: {e}")))?;

    if !resp.status().is_success() {
        return Err(map_err(resp, "drive.files.list").await);
    }

    let parsed: ListResp = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("parse drive list: {e}")))?;

    Ok(parsed.files.into_iter().next())
}

/// Download the raw bytes of a file by id. We use `alt=media` which is
/// Drive's way of saying "give me the content, not the metadata".
pub async fn download(access_token: &str, file_id: &str) -> Result<Vec<u8>, AppError> {
    let client = build_client()?;
    let url = format!("{DRIVE_FILES}/{file_id}");
    let resp = client
        .get(&url)
        .bearer_auth(access_token)
        .query(&[("alt", "media")])
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("drive.files.get: {e}")))?;

    if !resp.status().is_success() {
        return Err(map_err(resp, "drive.files.get").await);
    }

    let bytes = resp
        .bytes()
        .await
        .map_err(|e| AppError::Internal(format!("read drive body: {e}")))?;
    Ok(bytes.to_vec())
}

/// Metadata we send alongside bytes on create/update. Only name is required
/// for create; for update we pass `{}` because the name usually doesn't
/// change, but an empty-object metadata part is still required by the
/// multipart protocol.
#[derive(Serialize)]
struct UploadMeta<'a> {
    name: &'a str,
}

/// Create a new file in the user's Drive root with the given name + bytes.
/// Uses Drive's "multipart" upload: a single POST with a metadata JSON part
/// followed by the raw content part, glued with a MIME boundary.
pub async fn upload_new(
    access_token: &str,
    name: &str,
    bytes: Vec<u8>,
) -> Result<FileMeta, AppError> {
    let client = build_client()?;

    let meta = serde_json::to_vec(&UploadMeta { name })
        .map_err(|e| AppError::Internal(format!("serialize upload meta: {e}")))?;

    let metadata_part = reqwest::multipart::Part::bytes(meta)
        .mime_str("application/json; charset=UTF-8")
        .map_err(|e| AppError::Internal(format!("mime metadata: {e}")))?;
    let content_part = reqwest::multipart::Part::bytes(bytes)
        .mime_str("application/octet-stream")
        .map_err(|e| AppError::Internal(format!("mime content: {e}")))?;

    let form = reqwest::multipart::Form::new()
        .part("metadata", metadata_part)
        .part("media", content_part);

    let resp = client
        .post(DRIVE_UPLOAD)
        .bearer_auth(access_token)
        .query(&[
            ("uploadType", "multipart"),
            ("fields", "id,name,modifiedTime,size"),
        ])
        .multipart(form)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("drive.files.create: {e}")))?;

    if !resp.status().is_success() {
        return Err(map_err(resp, "drive.files.create").await);
    }

    resp.json::<FileMeta>()
        .await
        .map_err(|e| AppError::Internal(format!("parse drive create: {e}")))
}

/// Replace the content of an existing file. We send an empty metadata part
/// because we don't want to change the name — the file id is enough to
/// target the right file. Drive requires PATCH on the `upload` endpoint
/// for content replacement; a PATCH on the normal files endpoint would
/// only update metadata.
pub async fn update(
    access_token: &str,
    file_id: &str,
    bytes: Vec<u8>,
) -> Result<FileMeta, AppError> {
    let client = build_client()?;

    let metadata_part = reqwest::multipart::Part::bytes(b"{}".to_vec())
        .mime_str("application/json; charset=UTF-8")
        .map_err(|e| AppError::Internal(format!("mime metadata: {e}")))?;
    let content_part = reqwest::multipart::Part::bytes(bytes)
        .mime_str("application/octet-stream")
        .map_err(|e| AppError::Internal(format!("mime content: {e}")))?;

    let form = reqwest::multipart::Form::new()
        .part("metadata", metadata_part)
        .part("media", content_part);

    let url = format!("{DRIVE_UPLOAD}/{file_id}");
    let resp = client
        .patch(&url)
        .bearer_auth(access_token)
        .query(&[
            ("uploadType", "multipart"),
            ("fields", "id,name,modifiedTime,size"),
        ])
        .multipart(form)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("drive.files.update: {e}")))?;

    if !resp.status().is_success() {
        return Err(map_err(resp, "drive.files.update").await);
    }

    resp.json::<FileMeta>()
        .await
        .map_err(|e| AppError::Internal(format!("parse drive update: {e}")))
}

/// Fetch the minimal "about.user" to show the user which Google account
/// they connected. We only pull `displayName` and `emailAddress`, which
/// are available under the `drive.file` scope.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AccountInfo {
    #[serde(rename = "displayName")]
    pub display_name: Option<String>,
    #[serde(rename = "emailAddress")]
    pub email_address: Option<String>,
}

#[derive(Deserialize)]
struct AboutResp {
    user: AccountInfo,
}

pub async fn about_user(access_token: &str) -> Result<AccountInfo, AppError> {
    let client = build_client()?;
    let resp = client
        .get("https://www.googleapis.com/drive/v3/about")
        .bearer_auth(access_token)
        .query(&[("fields", "user(displayName,emailAddress)")])
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("drive.about: {e}")))?;

    if !resp.status().is_success() {
        return Err(map_err(resp, "drive.about").await);
    }

    let parsed: AboutResp = resp
        .json()
        .await
        .map_err(|e| AppError::Internal(format!("parse drive.about: {e}")))?;
    Ok(parsed.user)
}
