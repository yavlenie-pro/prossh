# Google Drive sync — OAuth client setup

ProSSH can sync sessions, port forwards, color profiles, scripts and stored
passwords across devices via Google Drive. The `drive.file` scope limits
access to files ProSSH itself created, so Google does *not* require the
app to go through sensitive-scope verification.

This document covers two things:

1. **End-user setup** — only needed if a release build ships without
   embedded credentials, or if someone wants to run their own OAuth app.
2. **Release build setup** — how the project owner bakes a shared
   `client_id` / `client_secret` into official binaries so end users can
   click one button and be done.

---

## 1. End-user setup (advanced — usually unnecessary)

Skip this if your build already has "Connect to Google Drive" working out
of the box — that means embedded credentials are baked in.

### 1.1 Create a Google Cloud project

1. Open <https://console.cloud.google.com/>
2. Project selector (top-left) → **New Project**
3. Name: anything (e.g. `ProSSH-personal`) → **Create**
4. Select the new project in the selector

### 1.2 Enable the Drive API

1. Search bar at the top: `Google Drive API` → open the result
2. Click **Enable**

### 1.3 Configure the OAuth consent screen

1. Left nav → **APIs & Services → OAuth consent screen**
2. User Type: **External** → **Create**
3. Fill in:
   - **App name:** anything sensible (e.g. `ProSSH`)
   - **User support email:** your email
   - **Developer contact:** your email
   - Home page / privacy policy can be left blank while the app is in
     Testing mode
4. **Save and Continue**
5. **Scopes** → **Add or Remove Scopes** → search `drive.file` →
   check `https://www.googleapis.com/auth/drive.file` → **Update** →
   **Save and Continue**
   - ⚠️ Only `drive.file`. That's a **non-sensitive** scope —
     verification is not required.
6. **Test users:** add your own Google account (so you can sign in while
   the app stays in Testing mode)
7. **Save and Continue**

### 1.4 Create the OAuth client

1. Left nav → **APIs & Services → Credentials**
2. **+ CREATE CREDENTIALS → OAuth client ID**
3. **Application type: Desktop app** ← must be Desktop, not Web
4. Name: `ProSSH Desktop` (or whatever)
5. **Create**
6. Copy the **Client ID** and **Client secret** from the modal (you can
   also retrieve them later from the Credentials page)

### 1.5 Paste into ProSSH

1. Settings → Sync → **Advanced — custom OAuth credentials**
2. Paste Client ID and Client secret
3. **Save**
4. **Connect to Google Drive** — browser will open; approve the consent
   screen for your test-user account

---

## 2. Release build setup (project owners only)

Shipping default credentials means end users never see the Cloud Console
dance — they just click **Connect to Google Drive** and it works.

### Is this safe?

Yes, for Desktop-app OAuth clients. From Google's own documentation:

> The process results in a client ID and, in some cases, a client secret,
> which you embed in the source code of your application. (In this context,
> the client secret is obviously not treated as a secret.)

The real protections for a Desktop OAuth app are PKCE and the loopback
redirect URI, which are still enforced regardless of where the `client_id`
lives. An attacker who extracts the secret from a shipped binary gains
nothing they couldn't get by registering their own OAuth client.

### 2.1 Register the OAuth client

Follow §1.1 through §1.4 above, but:

- App name: **ProSSH** (users see this on the consent screen)
- Pick a project name you don't mind being public (e.g. `prossh-sync`)
- In the consent screen config, fill in:
  - App home page: link to the GitHub repo or landing page
  - Privacy policy URL: required for Production publish
- After creating the credentials, go back to **OAuth consent screen** and
  click **Publish App**.
  - Since the only scope is `drive.file` (non-sensitive), publish completes
    immediately — no Google review, no "unverified app" warning.
  - Without publishing, the app stays in Testing mode and only the
    test users you've explicitly added can sign in (max 100).

### 2.2 Bake credentials into the build

Set env vars before `npm run tauri build`. The `option_env!` macro picks
them up at compile time (see [src-tauri/src/sync/mod.rs](../src-tauri/src/sync/mod.rs)).

**Git Bash / Linux / macOS:**

```bash
export PROSSH_GOOGLE_CLIENT_ID="1234567890-abc.apps.googleusercontent.com"
export PROSSH_GOOGLE_CLIENT_SECRET="GOCSPX-..."
npm run tauri build
```

**PowerShell:**

```powershell
$env:PROSSH_GOOGLE_CLIENT_ID="1234567890-abc.apps.googleusercontent.com"
$env:PROSSH_GOOGLE_CLIENT_SECRET="GOCSPX-..."
npm run tauri build
```

**GitHub Actions:**

Add `PROSSH_GOOGLE_CLIENT_ID` and `PROSSH_GOOGLE_CLIENT_SECRET` to repo
secrets, then wire them into the build step:

```yaml
- name: Build
  run: npm run tauri build
  env:
    PROSSH_GOOGLE_CLIENT_ID: ${{ secrets.PROSSH_GOOGLE_CLIENT_ID }}
    PROSSH_GOOGLE_CLIENT_SECRET: ${{ secrets.PROSSH_GOOGLE_CLIENT_SECRET }}
```

### 2.3 Verify

- Before building: `Settings → Sync` shows the Advanced section collapsed
  with the hint "using built-in credentials".
- `Connect to Google Drive` works on a fresh install without any user
  configuration.
- If the env vars were **not** set at build time, the Advanced section is
  still there and the user can paste their own — the code falls through
  gracefully.

### 2.4 What stops the shared credentials from being abused?

- **Quota:** if ProSSH gets wildly popular, the shared OAuth app may hit
  Google's per-project user quota. The fix is twofold: request a quota
  increase (free, usually granted for small apps), or let power users
  fall back to their own credentials via the Advanced section.
- **Revocation:** if Google ever revokes the shared credentials, the
  Advanced path still works — users can paste their own and sync keeps
  working.
- **Scope boundary:** `drive.file` only gives access to files the app
  itself creates. A compromised `client_secret` cannot read anything else
  in a user's Drive.
