# Robinhood Screener Export – Chrome Extension

Intercepts Robinhood stock screener results and exports them directly to Google Sheets.

## Project Structure

```
├── manifest.json      # MV3 manifest with permissions & OAuth config
├── background.js      # Service worker: message routing, data parsing, AI enrichment, Sheets API
├── content.js         # MAIN-world script: patches fetch/XHR on robinhood.com
├── bridge.js          # ISOLATED-world script: relays DOM events to background
├── popup.html         # Extension popup UI
├── popup.js           # Popup logic: auth, status, export triggers
├── popup.css          # Popup styles
├── options.html       # Settings page: AI provider & API key config
├── options.js         # Settings page logic
└── icons/             # Extension icons (16/48/128 px)
```

## Google Cloud Console Setup

Follow these steps **exactly** to configure OAuth so `chrome.identity` works:

### 1. Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/).
2. Click **Select a project** → **New Project**.
3. Name it (e.g., `RH Screener Export`) and click **Create**.

### 2. Enable the Google Sheets API

1. In your new project, go to **APIs & Services** → **Library**.
2. Search for **Google Sheets API** and click **Enable**.

### 3. Configure the OAuth Consent Screen

1. Go to **APIs & Services** → **OAuth consent screen**.
2. Choose **External** user type (unless you have a Workspace org) → **Create**.
3. Fill in:
   - **App name:** `Robinhood Screener Export`
   - **User support email:** your email
   - **Developer contact:** your email
4. Click **Save and Continue**.
5. On the **Scopes** page, click **Add or Remove Scopes** and add:
   - `https://www.googleapis.com/auth/spreadsheets`
6. Click **Save and Continue** through the remaining steps.
7. Under **Test users**, add your Google account email.

### 4. Create an OAuth 2.0 Client ID

1. Go to **APIs & Services** → **Credentials**.
2. Click **+ Create Credentials** → **OAuth client ID**.
3. Set **Application type** to **Chrome extension**.
4. For **Item ID**, you need the extension's ID from Chrome:
   - Load the extension first (see below), then copy the ID from `chrome://extensions`.
   - Or leave this blank for now and update after loading.
5. Click **Create**.
6. Copy the **Client ID** (looks like `123456789-abc.apps.googleusercontent.com`).

### 5. Update manifest.json

Open `manifest.json` and replace the placeholder:

```json
"oauth2": {
  "client_id": "YOUR_ACTUAL_CLIENT_ID.apps.googleusercontent.com",
  ...
}
```

## Install the Extension

1. Open Chrome and navigate to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** and select this project folder.
4. Note the **Extension ID** displayed under the extension name.
5. If you didn't set the Item ID in step 4 above, go back to the Cloud Console,
   edit the OAuth client, and paste the Extension ID into the **Item ID** field.

## Usage

1. Click the extension icon in Chrome's toolbar to open the popup.
2. Click **Login with Google** to authenticate.
3. Navigate to [robinhood.com](https://robinhood.com) and open the **Stock Screener**.
4. Run any screen – the extension silently intercepts the API response.
5. The popup will show the number of captured stocks and a timestamp.
6. Click **Export to Google Sheets** – the extension will enrich your data with AI analysis, then write it to a new sheet tab.
7. Click the **Open Spreadsheet** link to view the result.

## AI Enrichment Setup

The extension can enrich each stock with an AI-generated **Buy / Hold / Sell** decision, a short summary, and a detailed thesis. This step is **optional** — if you skip it, the export still works but the AI columns will say "No AI provider configured".

### Quick Start (Free — Groq)

If you don't want to pay for an API key, **Groq** offers a completely free tier:

1. Go to [console.groq.com/keys](https://console.groq.com/keys).
2. Sign up with your Google account (no credit card required).
3. Click **Create API Key** and copy it.
4. In the extension, click **⚙ Settings** at the bottom of the popup.
5. Select **Groq (Free)** from the Provider dropdown.
6. Paste your API key and click **Save Settings**.

That's it — your next export will include AI analysis.

### Using a Paid Provider

If you prefer a different model, the extension also supports OpenAI, Anthropic, and Google Gemini.

| Provider | Get your key at |
|----------|-----------------|
| **Groq** (free) | [console.groq.com/keys](https://console.groq.com/keys) |
| **Google Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| **OpenAI** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) |
| **Anthropic** | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) |

Steps are the same for any provider:

1. Open ⚙ **Settings** from the extension popup.
2. Pick your provider from the dropdown.
3. Paste the API key and click **Save Settings**.

> **Your key stays local.** It is stored in your browser's `chrome.storage.local` and only sent directly to the AI provider you selected — never to any other server.

### Subsequent Exports

Each export creates a new tab (e.g., `Screener_Snapshot_2026-04-18_1430`) inside the
same spreadsheet, so you build up a history of snapshots over time.

## How It Works

```
Robinhood page
  │  fetch("…/screener/…")
  ▼
content.js (MAIN world)
  │  patches fetch() → clones response → dispatches CustomEvent
  ▼
bridge.js (ISOLATED world)
  │  listens for CustomEvent → chrome.runtime.sendMessage()
  ▼
background.js (Service Worker)
  │  parses SDUI JSON → maps rows[1..n].items → stores in chrome.storage
  │  on export: AI enrichment (Groq/Gemini/OpenAI/Anthropic) → Sheets API v4
  ▼
Google Sheets
  └─ New tab with frozen header row + stock data + AI analysis columns
```

## Troubleshooting

| Problem | Fix |
|---------|-----|
| "Login with Google" does nothing | Check that `client_id` in manifest.json matches your Cloud Console OAuth client. Ensure the extension ID matches the one in the OAuth client's Item ID field. |
| No data captured | Make sure you're on `robinhood.com` (not a different subdomain). Open DevTools console and look for `[RH Screener Export]` log messages. |
| Export fails with 403 | Your Google account may not be listed as a test user in the OAuth consent screen. Add it and try again. |
| "Token not received" | The OAuth consent screen may still be in **Testing** mode and your account isn't added. Or the Sheets API isn't enabled. |
| AI columns say "No AI provider configured" | Open ⚙ Settings and save a provider + API key. The free Groq option requires no credit card. |
| AI columns say "AI Analysis Failed" | Your API key may be invalid or expired. Check the background service worker console for the full error message (right-click extension → Inspect views → service worker). |
