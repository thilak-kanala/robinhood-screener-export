// ── Options Page Script ──

const providerEl = document.getElementById("ai-provider");
const apiKeyEl = document.getElementById("ai-api-key");
const btnReveal = document.getElementById("btn-reveal");
const btnSave = document.getElementById("btn-save");
const btnClear = document.getElementById("btn-clear");
const statusEl = document.getElementById("status");

// ── Load saved settings on open ──────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  chrome.storage.local.get(["aiProvider", "aiApiKey"], (result) => {
    if (result.aiProvider) {
      providerEl.value = result.aiProvider;
    }
    if (result.aiApiKey) {
      // Show a masked placeholder so the user knows a key is saved
      apiKeyEl.placeholder = "Key saved — paste a new one to replace it";
    }
  });
});

// ── Show / Hide key ───────────────────────────────────────────────────────────
btnReveal.addEventListener("click", () => {
  if (apiKeyEl.type === "password") {
    apiKeyEl.type = "text";
    btnReveal.textContent = "Hide";
  } else {
    apiKeyEl.type = "password";
    btnReveal.textContent = "Show";
  }
});

// ── Save ──────────────────────────────────────────────────────────────────────
btnSave.addEventListener("click", () => {
  const provider = providerEl.value.trim();
  const apiKey = apiKeyEl.value.trim();

  if (!provider) {
    showStatus("Please select an AI provider.", "error");
    return;
  }
  if (!apiKey) {
    // If the field is empty the user might just be re-saving the provider
    // without re-entering the key — only update what changed.
    chrome.storage.local.get(["aiApiKey"], (result) => {
      if (!result.aiApiKey) {
        showStatus("Please enter an API key.", "error");
        return;
      }
      chrome.storage.local.set({ aiProvider: provider }, () => {
        showStatus("Provider saved.", "success");
      });
    });
    return;
  }

  chrome.storage.local.set({ aiProvider: provider, aiApiKey: apiKey }, () => {
    apiKeyEl.value = "";
    apiKeyEl.placeholder = "Key saved — paste a new one to replace it";
    apiKeyEl.type = "password";
    btnReveal.textContent = "Show";
    showStatus("Settings saved successfully.", "success");
  });
});

// ── Clear ─────────────────────────────────────────────────────────────────────
btnClear.addEventListener("click", () => {
  chrome.storage.local.remove(["aiProvider", "aiApiKey"], () => {
    providerEl.value = "";
    apiKeyEl.value = "";
    apiKeyEl.placeholder = "Paste your API key here";
    apiKeyEl.type = "password";
    btnReveal.textContent = "Show";
    showStatus("Settings cleared.", "success");
  });
});

// ── Helpers ───────────────────────────────────────────────────────────────────
function showStatus(msg, level) {
  statusEl.textContent = msg;
  statusEl.className = `show ${level}`;
  clearTimeout(showStatus._timer);
  showStatus._timer = setTimeout(() => {
    statusEl.className = "";
  }, 3000);
}
