# Retained — LeetCode → Google Drive

Manifest V3 Chrome extension that saves your accepted LeetCode solutions to a
`LeetCode-Solutions` folder in Google Drive, and offers to restore a saved
solution when you revisit a problem. Saving happens **automatically once your
submission is Accepted** — you can also save manually at any time via the
floating button. Pasting a previously saved solution back into the editor is
still entirely on your terms, via explicit Yes/No buttons — nothing is ever
pasted automatically.

## Files

- `manifest.template.json` — tracked in git; the real `manifest.json` (with your OAuth client ID) is generated from this and is gitignored
- `scripts/build-manifest.js` — generates `manifest.json` from `.env` + the template
- `.env.example` — copy to `.env` and fill in your own OAuth client ID
- `content.js` — runs the bottom-right corner UI, the Drive lookup, and the manual save/paste flow
- `background.js` — authenticates with Google Drive and uploads/looks up solutions
- `icons/` — toolbar icon

## How it behaves

- **On opening a problem page:** the extension checks Drive for a saved solution. A small "Checking for a saved solution…" indicator appears in the **bottom-right corner** (never full-screen, never blocking the page).
  - **Found:** a bottom-right card says "Solution available" and asks *"Paste it into the editor?"* with **Yes** / **No** buttons. Nothing is pasted unless you click **Yes**.
  - **Not found:** a bottom-right card says "No saved solution found" with a **💾 Save Solution** button.
- **Autosave on Accepted.** The extension watches for you clicking LeetCode's **Submit** button, then watches the verdict panel for a few seconds. If it comes back **Accepted**, your code is uploaded to Drive automatically — no click required. This only fires after a fresh Submit click, so it won't trigger from browsing your Submissions history or switching tabs.
- **Manual save is still available.** A **💾 Save Solution** button is always available in the bottom-right corner (as a small floating pill once you've dismissed the lookup card), so you can save a draft at any point, even before submitting.
- **On save (auto or manual):** a "Saving…" indicator appears, followed by a success toast, both in the same corner. The autosave toast is labeled "Accepted" so you can tell it apart from a manual save.

## Why it doesn't work "out of the box"

The code itself is complete and functional — the reason a freshly cloned copy of this repo won't work is that **Google OAuth client IDs are tied to a specific extension ID**. A client ID generated for one person's local unpacked copy will never authenticate for anyone else's install — Chrome's `chrome.identity.getAuthToken` call will silently fail (or show an "OAuth2 request failed" / "bad client id" error) because your unpacked extension gets a *different* auto-generated ID than theirs.

This isn't something that can be fixed by editing the code — you need to create your **own** OAuth client and keep it out of git (see setup below). It only takes a few minutes.

## Setup (required, one-time)

### 1. Load the unpacked extension first (to get its ID)

You need a `manifest.json` to load the extension at all, even before OAuth works. Generate a placeholder one now:

```bash
cp .env.example .env
node scripts/build-manifest.js
```

This writes `manifest.json` (gitignored — it will contain your real client ID once you fill in `.env`, so it never gets committed). For now it'll have a placeholder value, which is fine for this step.

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

### 3. Put the client ID in `.env`

Open `.env` (created in step 1) and set:

```
GOOGLE_OAUTH_CLIENT_ID=YOUR_REAL_CLIENT_ID.apps.googleusercontent.com
```

Then regenerate `manifest.json`:

```bash
node scripts/build-manifest.js
```

`.env` and `manifest.json` are both gitignored, so your client ID never gets committed.

### 4. Reload the extension

Back on `chrome://extensions/`, click the reload icon on the extension's card so it picks up the new `manifest.json`.

> Note: the Extension ID normally stays stable for a given unpacked folder path on your machine, so you shouldn't need to redo step 1/2 after this — just rerun `node scripts/build-manifest.js` and reload after any `.env` or code changes. If you ever move the folder to a new path or a different machine, Chrome may assign a new ID and you'll need to add that ID to the same OAuth client (Credentials → your client → Item ID can only hold one ID, so create a new OAuth client instead, or reuse it by re-registering).

## Using it

1. Go to any `https://leetcode.com/problems/...` page.
2. On first load, you'll see a small popup asking you to sign in with Google and grant Drive access — this happens automatically the first time the extension checks for or saves a solution.
3. The extension checks Drive for a saved solution (bottom-right indicator). If one exists, it asks whether to paste it into the editor — nothing is pasted without your say-so.
4. Write your solution and click **Submit** as normal. If it comes back **Accepted**, Retained saves it to Drive automatically. You can also click **💾 Save Solution** (bottom-right) at any time to save a draft manually.

## Notes

- Uses the narrower `drive.file` scope (not full `drive` access) — the extension can only see/manage files and folders it creates itself, not your entire Drive.
- If you ever revoke access, just reload the page and re-authenticate when prompted.
- If uploads/lookups stop working, open the extension's service worker console (`chrome://extensions/` → "service worker" link on the card) to see the actual error — most issues at that point are auth-related (client ID / test user list) rather than code bugs.
- If you previously had a real OAuth client ID committed in `manifest.json` in git history, rotate it in Google Cloud Console (delete the old credential, create a new one) now that it's out of the tracked files.
