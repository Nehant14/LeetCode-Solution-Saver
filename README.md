# LeetCode to Google Drive Saver

Manifest V3 Chrome extension that watches LeetCode problem pages, and when you get an **Accepted** verdict, automatically uploads your solution to a `LeetCode-Solutions` folder in your Google Drive. It also shows you any previously-saved solution for a problem when you revisit it.

## Files

- `manifest.json` — extension manifest and OAuth2 config
- `content.js` — detects an accepted submission, extracts title/language/code, and renders the on-page status UI
- `background.js` — authenticates with Google Drive and uploads/looks up solutions
- `icons/` — toolbar icon

## Why it doesn't work "out of the box"

The code itself is complete and functional — the reason a freshly cloned copy of this repo won't work is that **Google OAuth client IDs are tied to a specific extension ID**. The client ID that used to be hard-coded in `manifest.json` belonged to the original author's own local copy of the extension and will never authenticate for anyone else's install — Chrome's `chrome.identity.getAuthToken` call will silently fail (or show an "OAuth2 request failed" / "bad client id" error) because your unpacked extension gets a *different* auto-generated ID than theirs.

This isn't something that can be fixed by editing the code — you need to create your **own** OAuth client. It only takes a few minutes. Follow these steps exactly and it will work.

## Setup (required, one-time)

### 1. Load the unpacked extension first (to get its ID)

1. Open `chrome://extensions/`.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select this project folder.
4. It will load successfully (auth isn't wired up yet) and Chrome will assign it an **Extension ID** — a 32-character string shown on its card, e.g. `abcdefghijklmnopqrstuvwxyzabcdef`. Copy it.

### 2. Create a Google Cloud project + OAuth client

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a new project (or pick an existing one).
2. Enable the **Google Drive API**: APIs & Services → Library → search "Google Drive API" → Enable.
3. Configure the **OAuth consent screen** (APIs & Services → OAuth consent screen):
   - User type: External (unless you have a Workspace org) → Create.
   - Fill in app name, your email, etc. → Save and continue through the steps.
   - Under **Scopes**, you don't need to add anything manually here since the extension requests `drive.file` at runtime, but you can add it if prompted.
   - Under **Test users**, add the Google account(s) you'll actually use with the extension (required while the app is in "Testing" mode, which is fine for personal use — no Google verification needed).
4. Create the OAuth client: APIs & Services → Credentials → **Create Credentials → OAuth client ID**.
   - Application type: **Chrome Extension**.
   - Item ID: paste the Extension ID you copied in step 1.
   - Create → copy the generated **Client ID** (ends in `.apps.googleusercontent.com`).

### 3. Wire the client ID into the extension

Open `manifest.json` and replace the placeholder:

```json
"oauth2": {
  "client_id": "YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com",
  "scopes": ["https://www.googleapis.com/auth/drive.file"]
}
```

with your real client ID from step 2.

### 4. Reload the extension

Back on `chrome://extensions/`, click the reload icon on the extension's card so it picks up the new `manifest.json`.

> Note: the Extension ID normally stays stable for a given unpacked folder path on your machine, so you shouldn't need to redo step 1/2 after this — just reload after any code changes. If you ever move the folder to a new path or a different machine, Chrome may assign a new ID and you'll need to add that ID to the same OAuth client (Credentials → your client → Item ID can only hold one ID, so create a new OAuth client instead, or reuse it by re-registering).

## Using it

1. Go to any `https://leetcode.com/problems/...` page.
2. On first load, you'll see a small popup asking you to sign in with Google and grant Drive access — this happens automatically the first time you submit an accepted solution (or when it checks for an existing saved one).
3. Submit a solution and get **Accepted** — the extension detects it, shows a "Saving…" modal, and uploads the code as a file (e.g. `Two-Sum.cpp`) into a `LeetCode-Solutions` folder in your Drive.
4. Revisit a problem you've already solved — it automatically looks up and shows your saved solution, with a "Copy to clipboard" button.

## Notes

- Uses the narrower `drive.file` scope (not full `drive` access) — the extension can only see/manage files and folders it creates itself, not your entire Drive.
- If you ever revoke access, just reload the page and re-authenticate when prompted.
- If uploads/lookups stop working, open the extension's service worker console (`chrome://extensions/` → "service worker" link on the card) to see the actual error — most issues at that point are auth-related (client ID / test user list) rather than code bugs.
