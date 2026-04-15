//! Google OAuth 2.0 "Installed / Desktop App" flow with a loopback redirect.
//!
//! There's no "sign in with Google" widget available to a Tauri app, so we
//! implement the standard desktop flow manually:
//!
//! 1. Pick an unused port on `127.0.0.1`, bind a tiny one-shot HTTP server.
//! 2. Construct the auth URL including `redirect_uri=http://127.0.0.1:PORT`
//!    and open it in the user's default browser. Google shows its consent
//!    screen.
//! 3. When the user clicks Allow, Google redirects the browser to our
//!    loopback — we read the `?code=…` query parameter out of the HTTP
//!    request line, return a "you can close this tab" HTML response and
//!    shut the server down.
//! 4. Exchange the code for `access_token` + `refresh_token` at the token
//!    endpoint.
//!
//! We also do PKCE (RFC 7636) because Google now recommends it for desktop
//! apps and it costs nothing.
//!
//! The caller provides `client_id` and `client_secret` — the user creates
//! an "OAuth 2.0 Client ID / Desktop app" entry in Google Cloud Console
//! and pastes both into Settings → Sync. We never ship embedded credentials.

use std::time::{Duration, SystemTime};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine as _;
use rand::rngs::OsRng;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

use crate::error::AppError;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
pub const DRIVE_SCOPE: &str = "https://www.googleapis.com/auth/drive.file";

/// Tokens held after a successful auth flow. Only `refresh_token` is
/// long-lived; `access_token` expires after ~1h and we refresh it
/// transparently before each Drive API call.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tokens {
    pub access_token: String,
    pub refresh_token: String,
    /// UNIX seconds at which `access_token` stops working.
    pub expires_at: u64,
    pub scope: String,
    pub token_type: String,
}

impl Tokens {
    pub fn is_expired(&self) -> bool {
        now_secs().saturating_add(30) >= self.expires_at
    }
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

// ---- PKCE helpers ----

fn random_verifier() -> String {
    let mut buf = [0u8; 32];
    OsRng.fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

fn s256_challenge(verifier: &str) -> String {
    let digest = Sha256::digest(verifier.as_bytes());
    URL_SAFE_NO_PAD.encode(digest)
}

fn random_state() -> String {
    let mut buf = [0u8; 16];
    OsRng.fill_bytes(&mut buf);
    URL_SAFE_NO_PAD.encode(buf)
}

// ---- the full flow ----

/// Run the full authorisation dance. This function:
///
/// - binds a loopback listener,
/// - constructs the auth URL and returns it via the `open_browser` callback,
/// - waits for the redirect (with a 5-minute ceiling so a user who walks
///   away doesn't leave a dangling task forever),
/// - exchanges the code for tokens.
///
/// The closure gives the caller a chance to open the URL in their preferred
/// way (tauri shell plugin, `open::that`, …) — keeps this module
/// self-contained and easy to unit-test.
pub async fn run_desktop_flow<F>(
    client_id: &str,
    client_secret: &str,
    open_browser: F,
) -> Result<Tokens, AppError>
where
    F: FnOnce(&str) -> Result<(), AppError>,
{
    if client_id.is_empty() {
        return Err(AppError::InvalidArgument(
            "Google OAuth client ID is not configured — set it in Settings → Sync".into(),
        ));
    }
    if client_secret.is_empty() {
        return Err(AppError::InvalidArgument(
            "Google OAuth client secret is not configured — set it in Settings → Sync".into(),
        ));
    }

    // Bind to 127.0.0.1:0 — the kernel picks a free port. We reuse that
    // port number in the redirect URI we give Google.
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .map_err(|e| AppError::Io(format!("bind loopback: {e}")))?;
    let port = listener
        .local_addr()
        .map_err(|e| AppError::Io(format!("local_addr: {e}")))?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}");

    let verifier = random_verifier();
    let challenge = s256_challenge(&verifier);
    let state = random_state();

    // Build auth URL.
    let auth_url = {
        let mut u = url::Url::parse(AUTH_URL).unwrap();
        u.query_pairs_mut()
            .append_pair("response_type", "code")
            .append_pair("client_id", client_id)
            .append_pair("redirect_uri", &redirect_uri)
            .append_pair("scope", DRIVE_SCOPE)
            .append_pair("access_type", "offline")
            // `prompt=consent` forces Google to hand out a new refresh_token
            // even if the user already granted access previously. Without
            // this, re-authorising the same account returns an access_token
            // but no refresh_token, and we'd silently lose long-term access.
            .append_pair("prompt", "consent")
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state);
        u.to_string()
    };

    open_browser(&auth_url)?;

    // Wait for the browser to hit our loopback. Cap at 5 minutes so we
    // don't leak the listener if the user abandons the flow.
    let (code, returned_state) = tokio::time::timeout(
        Duration::from_secs(300),
        accept_callback(&listener),
    )
    .await
    .map_err(|_| AppError::Internal("OAuth flow timed out after 5 minutes".into()))??;

    if returned_state != state {
        return Err(AppError::Internal(
            "OAuth state mismatch — possible CSRF, aborting".into(),
        ));
    }

    exchange_code(client_id, client_secret, &code, &verifier, &redirect_uri).await
}

/// Read one HTTP request off the socket, parse the query string of the
/// request-line, and return `(code, state)`. The other end gets a tiny HTML
/// confirmation page that closes the tab.
async fn accept_callback(listener: &TcpListener) -> Result<(String, String), AppError> {
    loop {
        let (mut socket, _addr) = listener
            .accept()
            .await
            .map_err(|e| AppError::Io(format!("accept loopback: {e}")))?;

        // Read up to the end of headers. The browser sends a GET with no
        // body, so a small buffer is plenty; we bail after 8 KiB in case
        // of weird clients.
        let mut buf = vec![0u8; 8192];
        let mut total = 0usize;
        loop {
            let n = socket
                .read(&mut buf[total..])
                .await
                .map_err(|e| AppError::Io(format!("read loopback: {e}")))?;
            if n == 0 {
                break;
            }
            total += n;
            if total >= 4 && buf[..total].windows(4).any(|w| w == b"\r\n\r\n") {
                break;
            }
            if total == buf.len() {
                break;
            }
        }
        let text = String::from_utf8_lossy(&buf[..total]);
        let first_line = text.lines().next().unwrap_or("");
        // Expected form:  GET /?code=XYZ&state=ABC&scope=... HTTP/1.1
        let path_and_query = first_line
            .split_whitespace()
            .nth(1)
            .unwrap_or("");
        // Browsers and some proxies probe loopback servers (favicon, etc.).
        // Ignore anything that doesn't contain `code=`.
        let full_url = format!("http://127.0.0.1{path_and_query}");
        let parsed = match url::Url::parse(&full_url) {
            Ok(u) => u,
            Err(_) => {
                let _ = write_html(&mut socket, 400, "Bad request").await;
                continue;
            }
        };
        let mut code = None;
        let mut state = None;
        let mut error = None;
        for (k, v) in parsed.query_pairs() {
            match k.as_ref() {
                "code" => code = Some(v.into_owned()),
                "state" => state = Some(v.into_owned()),
                "error" => error = Some(v.into_owned()),
                _ => {}
            }
        }
        if let Some(err) = error {
            let _ = write_html(
                &mut socket,
                400,
                &format!("<h1>Authorization failed</h1><p>{err}</p>"),
            )
            .await;
            return Err(AppError::Internal(format!("Google returned error: {err}")));
        }
        if let (Some(code), Some(state)) = (code, state) {
            let _ = write_html(
                &mut socket,
                200,
                "<h1>ProSSH connected to Google Drive</h1>\
                 <p>You can close this tab and return to the app.</p>\
                 <script>setTimeout(()=>window.close(), 500)</script>",
            )
            .await;
            return Ok((code, state));
        }
        // Missing code — probably a probe. Respond 404 and keep listening.
        let _ = write_html(&mut socket, 404, "not the droids you're looking for").await;
    }
}

async fn write_html(
    socket: &mut tokio::net::TcpStream,
    status: u16,
    body: &str,
) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        _ => "Error",
    };
    let response = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {len}\r\n\
         Connection: close\r\n\
         \r\n{body}",
        len = body.len(),
    );
    socket.write_all(response.as_bytes()).await?;
    socket.shutdown().await
}

// ---- token endpoint ----

async fn exchange_code(
    client_id: &str,
    client_secret: &str,
    code: &str,
    verifier: &str,
    redirect_uri: &str,
) -> Result<Tokens, AppError> {
    #[derive(Deserialize)]
    struct Resp {
        access_token: String,
        refresh_token: Option<String>,
        expires_in: u64,
        scope: String,
        token_type: String,
    }

    let params = [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("client_id", client_id),
        ("client_secret", client_secret),
        ("redirect_uri", redirect_uri),
        ("code_verifier", verifier),
    ];

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::Internal(format!("build reqwest: {e}")))?;

    let resp = client
        .post(TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("token request: {e}")))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Internal(format!("read token body: {e}")))?;

    if !status.is_success() {
        return Err(AppError::Internal(format!(
            "token endpoint returned {status}: {body}"
        )));
    }

    let parsed: Resp = serde_json::from_str(&body)
        .map_err(|e| AppError::Internal(format!("parse token json: {e}: {body}")))?;

    let refresh = parsed.refresh_token.ok_or_else(|| {
        AppError::Internal(
            "Google did not return a refresh_token — revoke the app's access in your Google \
             account (myaccount.google.com/permissions) and try connecting again"
                .into(),
        )
    })?;

    Ok(Tokens {
        access_token: parsed.access_token,
        refresh_token: refresh,
        expires_at: now_secs() + parsed.expires_in,
        scope: parsed.scope,
        token_type: parsed.token_type,
    })
}

/// Use a `refresh_token` to obtain a fresh `access_token`. Google normally
/// doesn't return a new refresh_token here — we keep the existing one.
pub async fn refresh(
    client_id: &str,
    client_secret: &str,
    refresh_token: &str,
) -> Result<Tokens, AppError> {
    #[derive(Deserialize)]
    struct Resp {
        access_token: String,
        refresh_token: Option<String>,
        expires_in: u64,
        scope: Option<String>,
        token_type: String,
    }

    let params = [
        ("grant_type", "refresh_token"),
        ("refresh_token", refresh_token),
        ("client_id", client_id),
        ("client_secret", client_secret),
    ];

    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| AppError::Internal(format!("build reqwest: {e}")))?;

    let resp = client
        .post(TOKEN_URL)
        .form(&params)
        .send()
        .await
        .map_err(|e| AppError::Internal(format!("refresh request: {e}")))?;

    let status = resp.status();
    let body = resp
        .text()
        .await
        .map_err(|e| AppError::Internal(format!("read refresh body: {e}")))?;

    if !status.is_success() {
        return Err(AppError::Internal(format!(
            "refresh endpoint returned {status}: {body}"
        )));
    }

    let parsed: Resp = serde_json::from_str(&body)
        .map_err(|e| AppError::Internal(format!("parse refresh json: {e}: {body}")))?;

    Ok(Tokens {
        access_token: parsed.access_token,
        refresh_token: parsed.refresh_token.unwrap_or_else(|| refresh_token.to_string()),
        expires_at: now_secs() + parsed.expires_in,
        scope: parsed.scope.unwrap_or_else(|| DRIVE_SCOPE.to_string()),
        token_type: parsed.token_type,
    })
}

/// Best-effort revoke — tell Google to invalidate our refresh token. We
/// don't care about the result; even if it fails, the user can still
/// delete permissions manually in their Google account.
pub async fn revoke(token: &str) {
    let client = match reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(15))
        .build()
    {
        Ok(c) => c,
        Err(_) => return,
    };
    let _ = client
        .post("https://oauth2.googleapis.com/revoke")
        .form(&[("token", token)])
        .send()
        .await;
}
