# LeetCode to Google Drive Saver

Manifest V3 Chrome extension that watches LeetCode problem pages and uploads accepted solutions to Google Drive.

## Files

- `manifest.json` - extension manifest and OAuth2 placeholder
- `content.js` - detects an accepted submission and extracts title, language, and source code
- `background.js` - authenticates with Google Drive and uploads the solution into `LeetCode-Solutions`

## Google OAuth Setup

1. Create an OAuth client in Google Cloud Console for Chrome extension use.
2. Copy your OAuth client ID into `manifest.json`:

```json
"oauth2": {
  "client_id": "YOUR_GOOGLE_OAUTH_CLIENT_ID.apps.googleusercontent.com",
  "scopes": ["https://www.googleapis.com/auth/drive"]
}
```

3. Make sure the OAuth client is allowed to request the Google Drive scope used by the extension.

## Load Into Chrome

1. Open `chrome://extensions/`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the `d:\ChromeExtension` folder.
5. Pin the extension if you want quick access.

## Behavior

- The extension only runs on `https://leetcode.com/problems/*`.
- When an accepted submission appears, `content.js` extracts the problem title, the editor language, and the current source code.
- `background.js` requests a Google Drive token through `chrome.identity.getAuthToken`, creates the `LeetCode-Solutions` folder if needed, and uploads the code as a file such as `Two-Sum.cpp`.
- The content script opens a small status dialog while saving to Drive and while loading a saved solution so you can see that it is working.

## Notes

- The extension uses the Google Drive scope so it can search for and create the dedicated folder.
- If you change the OAuth client ID, reload the extension from `chrome://extensions/`.
