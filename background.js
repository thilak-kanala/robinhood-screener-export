// ── Robinhood Screener Export – Background Service Worker ──

const SCREENER_URL_PATTERN = /robinhood\.com\/.*screener/i;
const SCREENER_API_PATTERNS = [
  /midlands\/screener\/results/i,
  /dora\/fetch/i,
  /screener_results/i,
  /midlands\/ratings/i,
];

// In-memory store for the latest parsed screener data
let latestScreenerData = null;

// ── 1. Network Interception ──────────────────────────────────────────────────
// MV3 uses declarativeNetRequest for blocking, but for passive observation
// we attach a debugger-free approach: we inject a content script that
// monkey-patches fetch/XHR on Robinhood pages. However the simplest MV3
// approach for read-only observation is webRequest.onCompleted + a content
// script to read bodies. Since webRequest in MV3 cannot read response bodies,
// we use a content script injected via the background to intercept fetch.

// Register the content script dynamically so we don't need a static entry
chrome.runtime.onInstalled.addListener(() => {
  chrome.scripting
    .registerContentScripts([
      {
        id: "rh-interceptor",
        matches: ["https://robinhood.com/*", "https://*.robinhood.com/*"],
        js: ["content.js"],
        runAt: "document_start",
        world: "MAIN", // MAIN world so we can override fetch/XHR
        allFrames: false,
      },
    ])
    .catch(() => {
      // Script might already be registered from a prior install
      chrome.scripting.updateContentScripts([
        {
          id: "rh-interceptor",
          matches: ["https://robinhood.com/*", "https://*.robinhood.com/*"],
          js: ["content.js"],
          runAt: "document_start",
          world: "MAIN",
          allFrames: false,
        },
      ]);
    });
});

// ── 2. Message Listener (from content script & popup) ────────────────────────
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === "SCREENER_PAYLOAD") {
    const parsed = parseScreenerPayload(message.payload);
    if (parsed && parsed.length > 0) {
      latestScreenerData = parsed;
      chrome.storage.local.set({
        screenerData: parsed,
        capturedAt: new Date().toISOString(),
      });
      // Notify popup if it's open
      chrome.runtime
        .sendMessage({
          type: "DATA_READY",
          count: parsed.length,
        })
        .catch(() => {});
    }
    sendResponse({ ok: true, count: parsed ? parsed.length : 0 });
    return false;
  }

  if (message.type === "GET_STATUS") {
    chrome.storage.local.get(["screenerData", "capturedAt"], (result) => {
      sendResponse({
        hasData: !!(result.screenerData && result.screenerData.length),
        count: result.screenerData ? result.screenerData.length : 0,
        capturedAt: result.capturedAt || null,
      });
    });
    return true; // async sendResponse
  }

  if (message.type === "EXPORT_TO_SHEETS") {
    chrome.storage.local.get(["screenerData"], (result) => {
      if (!result.screenerData || result.screenerData.length === 0) {
        sendResponse({ ok: false, error: "No screener data captured yet." });
        return;
      }
      enrichWithAI(result.screenerData)
        .then((enriched) => exportToGoogleSheets(enriched))
        .then((url) => sendResponse({ ok: true, sheetUrl: url }))
        .catch((err) => sendResponse({ ok: false, error: err.message }));
    });
    return true; // async sendResponse
  }

  if (message.type === "AUTH_GOOGLE") {
    getGoogleAuthToken(true)
      .then((token) => sendResponse({ ok: true, token }))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
    return true;
  }

  if (message.type === "CHECK_AUTH") {
    chrome.storage.local.get(["oauthToken", "oauthExpiry"], (result) => {
      const isValid = !!(
        result.oauthToken &&
        result.oauthExpiry &&
        Date.now() < result.oauthExpiry - 60_000
      );
      sendResponse({ ok: true, authenticated: isValid });
    });
    return true;
  }

  if (message.type === "LOGOUT_GOOGLE") {
    chrome.storage.local.get(["oauthToken"], (result) => {
      const token = result.oauthToken;
      chrome.storage.local.remove(["oauthToken", "oauthExpiry"], () => {
        if (token) {
          // Revoke server-side so the token can't be reused
          fetch(
            `https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(token)}`,
            { method: "POST" },
          ).finally(() => sendResponse({ ok: true }));
        } else {
          sendResponse({ ok: true });
        }
      });
    });
    return true;
  }
});

// ── 3. Data Extraction & Mapping ─────────────────────────────────────────────
function parseScreenerPayload(payload) {
  try {
    const data = typeof payload === "string" ? JSON.parse(payload) : payload;
    const rows = findRows(data);
    if (!rows || rows.length < 2) return null;

    const results = [];
    // rows[0] is the header row (instrument_id === ""), skip it
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      // Skip header rows
      if (!row.instrument_id && row.instrument_id !== undefined) continue;
      if (row.instrument_id === "") continue;

      const mapped = extractRowData(row);
      if (mapped && mapped.ticker) {
        results.push(mapped);
      }
    }
    return results;
  } catch (e) {
    console.error("[RH Export] Failed to parse screener payload:", e);
    return null;
  }
}

function findRows(data) {
  // Direct access
  if (Array.isArray(data.rows)) return data.rows;

  // Deep search – the SDUI payload may nest rows inside body/sections
  if (typeof data === "object" && data !== null) {
    for (const key of Object.keys(data)) {
      if (key === "rows" && Array.isArray(data[key])) return data[key];
      if (typeof data[key] === "object") {
        const found = findRows(data[key]);
        if (found) return found;
      }
    }
  }
  return null;
}

function safeGet(obj, path) {
  return path
    .split(".")
    .reduce((o, k) => (o && o[k] !== undefined ? o[k] : null), obj);
}

function extractRowData(row) {
  const items = row.items || [];
  return {
    ticker: row.instrument_symbol || row.symbol || "",
    companyName: safeGet(items[0], "component.name") || "",
    price: safeGet(items[2], "component.default_value") || "",
    oneDayChange:
      safeGet(items[3], "component.default_value.value") ||
      safeGet(items[3], "component.default_value") ||
      "",
    volume: safeGet(items[4], "component.text.text") || "",
    marketCap: safeGet(items[5], "component.text.text") || "",
    analystRating: safeGet(items[10], "component.text.text") || "",
  };
}

// ── 4. Google Auth Helper ────────────────────────────────────────────────────
// Uses launchWebAuthFlow (OAuth2 implicit grant) for cross-browser compatibility.
// chrome.identity.getAuthToken() is Chrome-only and throws on Edge.

const OAUTH_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

function getClientId() {
  return chrome.runtime.getManifest().oauth2?.client_id || "";
}

async function getGoogleAuthToken(interactive) {
  // Return cached token if still valid (60s safety buffer)
  const stored = await chrome.storage.local.get(["oauthToken", "oauthExpiry"]);
  if (
    stored.oauthToken &&
    stored.oauthExpiry &&
    Date.now() < stored.oauthExpiry - 60_000
  ) {
    return stored.oauthToken;
  }

  if (!interactive) {
    throw new Error("No valid cached token. Please log in.");
  }

  const clientId = getClientId();
  if (!clientId) {
    throw new Error(
      "OAuth client_id is not configured in manifest.json. See README for setup instructions.",
    );
  }

  const redirectURL = chrome.identity.getRedirectURL();
  const authURL = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authURL.searchParams.set("client_id", clientId);
  authURL.searchParams.set("response_type", "token");
  authURL.searchParams.set("redirect_uri", redirectURL);
  authURL.searchParams.set("scope", OAUTH_SCOPE);
  authURL.searchParams.set("prompt", "select_account");

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authURL.toString(), interactive: true },
      (responseUrl) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!responseUrl) {
          reject(new Error("OAuth flow was cancelled."));
          return;
        }
        try {
          // Token is in the URL fragment: #access_token=...&expires_in=...
          const hash = new URL(responseUrl).hash.slice(1);
          const params = new URLSearchParams(hash);
          const token = params.get("access_token");
          const expiresIn = parseInt(params.get("expires_in") || "3600", 10);
          if (!token) {
            reject(new Error("No access_token in OAuth response."));
            return;
          }
          chrome.storage.local.set({
            oauthToken: token,
            oauthExpiry: Date.now() + expiresIn * 1000,
          });
          resolve(token);
        } catch (e) {
          reject(new Error("Failed to parse OAuth response: " + e.message));
        }
      },
    );
  });
}

// ── 5. AI Enrichment Layer ───────────────────────────────────────────────────

const AI_SYSTEM_PROMPT =
  "You are an expert financial analyst. Analyze the following list of stocks " +
  "and their metrics. For each stock, provide a JSON object containing: " +
  '1. "ticker" (matching the input exactly), ' +
  "2. \"decision\" (Strictly 'Buy', 'Hold', or 'Sell'), " +
  '3. "summary" (A concise 1-2 sentence explanation), ' +
  '4. "detailed_thesis" (A thorough paragraph analyzing the valuation, ' +
  "momentum, and risk based on the provided metrics). " +
  "Return ONLY a valid JSON array with no surrounding text or markdown fences.";

async function enrichWithAI(stocks) {
  const cfg = await chrome.storage.local.get(["aiProvider", "aiApiKey"]);
  if (!cfg.aiProvider || !cfg.aiApiKey) {
    console.warn(
      "[RH Export] No AI provider configured – skipping enrichment.",
    );
    return applyAIFallback(stocks, "No AI provider configured");
  }

  const userContent = JSON.stringify(
    stocks.map((s) => ({
      ticker: s.ticker,
      companyName: s.companyName,
      price: s.price,
      oneDayChange: s.oneDayChange,
      volume: s.volume,
      marketCap: s.marketCap,
      analystRating: s.analystRating,
    })),
  );

  try {
    const responseJson = await callAIProvider(
      cfg.aiProvider,
      cfg.aiApiKey,
      AI_SYSTEM_PROMPT,
      userContent,
    );
    const analyses = parseAIResponse(cfg.aiProvider, responseJson);
    return mergeAIAnalysis(stocks, analyses);
  } catch (e) {
    console.error("[RH Export] AI enrichment failed:", e);
    return applyAIFallback(stocks, "AI Analysis Failed");
  }
}

async function callAIProvider(provider, apiKey, systemPrompt, userContent) {
  let url, headers, body;

  if (provider === "openai") {
    url = "https://api.openai.com/v1/chat/completions";
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
    body = JSON.stringify({
      model: "gpt-4o",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0.3,
    });
  } else if (provider === "anthropic") {
    url = "https://api.anthropic.com/v1/messages";
    headers = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
    body = JSON.stringify({
      model: "claude-opus-4-5",
      max_tokens: 4096,
      system: systemPrompt,
      messages: [{ role: "user", content: userContent }],
    });
  } else if (provider === "gemini") {
    url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`;
    headers = { "Content-Type": "application/json" };
    body = JSON.stringify({
      system_instruction: { parts: [{ text: systemPrompt }] },
      contents: [{ parts: [{ text: userContent }] }],
      generationConfig: { responseMimeType: "application/json" },
    });
  } else if (provider === "groq") {
    url = "https://api.groq.com/openai/v1/chat/completions";
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
    body = JSON.stringify({
      model: "llama-3.3-70b-versatile",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      temperature: 0.3,
    });
  } else {
    throw new Error(`Unknown AI provider: ${provider}`);
  }

  const res = await fetch(url, { method: "POST", headers, body });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`AI API error ${res.status}: ${errText}`);
  }
  return res.json();
}

function parseAIResponse(provider, responseJson) {
  let rawText = "";
  if (provider === "openai") {
    rawText = responseJson?.choices?.[0]?.message?.content || "";
  } else if (provider === "anthropic") {
    rawText = responseJson?.content?.[0]?.text || "";
  } else if (provider === "gemini") {
    rawText = responseJson?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  } else if (provider === "groq") {
    rawText = responseJson?.choices?.[0]?.message?.content || "";
  }

  // Strip markdown code fences if present
  rawText = rawText
    .trim()
    .replace(/^```(?:json)?\n?/, "")
    .replace(/\n?```$/, "");

  let parsed = JSON.parse(rawText);
  // If the model wrapped the array in an object, unwrap it
  if (!Array.isArray(parsed)) {
    const key = Object.keys(parsed).find((k) => Array.isArray(parsed[k]));
    if (key) {
      parsed = parsed[key];
    } else {
      throw new Error("AI response did not contain a JSON array.");
    }
  }
  return parsed;
}

function mergeAIAnalysis(stocks, analyses) {
  const map = new Map(analyses.map((a) => [String(a.ticker).toUpperCase(), a]));
  return stocks.map((stock) => {
    const ai = map.get(String(stock.ticker).toUpperCase());
    return {
      ...stock,
      aiDecision: ai?.decision || "AI Analysis Failed",
      aiSummary: ai?.summary || "",
      aiDetailedThesis: ai?.detailed_thesis || "",
    };
  });
}

function applyAIFallback(stocks, reason) {
  return stocks.map((stock) => ({
    ...stock,
    aiDecision: reason,
    aiSummary: "",
    aiDetailedThesis: "",
  }));
}

// ── 6. Google Sheets Export ──────────────────────────────────────────────────
async function exportToGoogleSheets(data) {
  const token = await getGoogleAuthToken(false);
  const now = new Date();
  const sheetTitle = `Screener_Snapshot_${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}_${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}${String(now.getSeconds()).padStart(2, "0")}`;

  // Check if we have an existing spreadsheet ID stored
  const stored = await chrome.storage.local.get(["spreadsheetId"]);
  let spreadsheetId = stored.spreadsheetId;

  if (spreadsheetId) {
    // Add a new sheet tab to the existing spreadsheet
    try {
      await addSheetTab(token, spreadsheetId, sheetTitle, data);
      return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
    } catch (e) {
      // If the spreadsheet was deleted or we lost access, create a new one
      console.warn(
        "[RH Export] Could not add tab, creating new spreadsheet:",
        e,
      );
      spreadsheetId = null;
    }
  }

  // Create a brand-new spreadsheet
  const createRes = await fetch(
    "https://sheets.googleapis.com/v4/spreadsheets",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        properties: { title: "Robinhood Screener Exports" },
        sheets: [
          {
            properties: {
              title: sheetTitle,
              gridProperties: { frozenRowCount: 1 },
            },
          },
        ],
      }),
    },
  );

  if (!createRes.ok) {
    const errBody = await createRes.text();
    throw new Error(
      `Failed to create spreadsheet: ${createRes.status} ${errBody}`,
    );
  }

  const spreadsheet = await createRes.json();
  spreadsheetId = spreadsheet.spreadsheetId;
  await chrome.storage.local.set({ spreadsheetId });

  // Write data
  await writeDataToSheet(token, spreadsheetId, sheetTitle, data);

  // Apply header formatting
  const sheetId = spreadsheet.sheets[0].properties.sheetId;
  await formatHeaderRow(token, spreadsheetId, sheetId);

  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
}

async function addSheetTab(token, spreadsheetId, sheetTitle, data) {
  // Add new sheet tab
  const addRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [
          {
            addSheet: {
              properties: {
                title: sheetTitle,
                gridProperties: { frozenRowCount: 1 },
              },
            },
          },
        ],
      }),
    },
  );

  if (!addRes.ok) {
    const errBody = await addRes.text();
    throw new Error(`Failed to add sheet tab: ${addRes.status} ${errBody}`);
  }

  const addResult = await addRes.json();
  const newSheetId = addResult.replies[0].addSheet.properties.sheetId;

  await writeDataToSheet(token, spreadsheetId, sheetTitle, data);
  await formatHeaderRow(token, spreadsheetId, newSheetId);
}

async function writeDataToSheet(token, spreadsheetId, sheetTitle, data) {
  const headers = [
    "Ticker",
    "Company Name",
    "Price",
    "1D Change",
    "Volume",
    "Market Cap",
    "Analyst Rating",
    "AI Decision",
    "AI Summary",
    "Detailed AI Thesis",
  ];

  const rows = [headers];
  for (const item of data) {
    rows.push([
      item.ticker,
      item.companyName,
      item.price,
      item.oneDayChange,
      item.volume,
      item.marketCap,
      item.analystRating,
      item.aiDecision || "",
      item.aiSummary || "",
      item.aiDetailedThesis || "",
    ]);
  }

  const range = `'${sheetTitle}'!A1`;
  const writeRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`,
    {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ values: rows }),
    },
  );

  if (!writeRes.ok) {
    const errBody = await writeRes.text();
    throw new Error(`Failed to write data: ${writeRes.status} ${errBody}`);
  }
}

async function formatHeaderRow(token, spreadsheetId, sheetId) {
  await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        requests: [
          {
            repeatCell: {
              range: {
                sheetId,
                startRowIndex: 0,
                endRowIndex: 1,
              },
              cell: {
                userEnteredFormat: {
                  backgroundColor: { red: 0.15, green: 0.15, blue: 0.15 },
                  textFormat: {
                    bold: true,
                    foregroundColor: { red: 1, green: 1, blue: 1 },
                  },
                },
              },
              fields: "userEnteredFormat(backgroundColor,textFormat)",
            },
          },
          {
            autoResizeDimensions: {
              dimensions: {
                sheetId,
                dimension: "COLUMNS",
                startIndex: 0,
                endIndex: 10,
              },
            },
          },
        ],
      }),
    },
  );
}
