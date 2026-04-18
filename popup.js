// ── Popup Script ──

const $ = (sel) => document.querySelector(sel);

const els = {
  loggedOut: $("#logged-out"),
  loggedIn: $("#logged-in"),
  btnLogin: $("#btn-login"),
  btnLogout: $("#btn-logout"),
  noData: $("#no-data"),
  hasData: $("#has-data"),
  stockCount: $("#stock-count"),
  capturedTime: $("#captured-time"),
  btnExport: $("#btn-export"),
  exportStatus: $("#export-status"),
  sheetLink: $("#sheet-link"),
  btnSettings: $("#btn-settings"),
};

// ── Init ──────────────────────────────────────────────────────────────────────
document.addEventListener("DOMContentLoaded", () => {
  checkAuth();
  checkDataStatus();
  attachListeners();
});

// ── Auth ──────────────────────────────────────────────────────────────────────
function checkAuth() {
  chrome.runtime.sendMessage({ type: "CHECK_AUTH" }, (res) => {
    if (res && res.authenticated) {
      showLoggedIn();
    } else {
      showLoggedOut();
    }
  });
}

function showLoggedIn() {
  els.loggedOut.classList.add("hidden");
  els.loggedIn.classList.remove("hidden");
  updateExportButton();
}

function showLoggedOut() {
  els.loggedOut.classList.remove("hidden");
  els.loggedIn.classList.add("hidden");
  els.btnExport.disabled = true;
}

// ── Data Status ──────────────────────────────────────────────────────────────
function checkDataStatus() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => {
    if (res && res.hasData) {
      showDataReady(res.count, res.capturedAt);
    } else {
      showNoData();
    }
  });
}

function showDataReady(count, capturedAt) {
  els.noData.classList.add("hidden");
  els.hasData.classList.remove("hidden");
  els.stockCount.textContent = `${count} stock${count !== 1 ? "s" : ""}`;
  if (capturedAt) {
    const d = new Date(capturedAt);
    els.capturedTime.textContent = `Captured ${d.toLocaleTimeString()}`;
  }
  updateExportButton();
}

function showNoData() {
  els.noData.classList.remove("hidden");
  els.hasData.classList.add("hidden");
  els.btnExport.disabled = true;
}

function updateExportButton() {
  chrome.runtime.sendMessage({ type: "GET_STATUS" }, (res) => {
    chrome.runtime.sendMessage({ type: "CHECK_AUTH" }, (authRes) => {
      const hasData = res && res.hasData;
      const isAuth = authRes && authRes.authenticated;
      els.btnExport.disabled = !(hasData && isAuth);
    });
  });
}

// ── Listeners ────────────────────────────────────────────────────────────────
function attachListeners() {
  els.btnLogin.addEventListener("click", () => {
    els.btnLogin.disabled = true;
    els.btnLogin.textContent = "Authenticating…";
    chrome.runtime.sendMessage({ type: "AUTH_GOOGLE" }, (res) => {
      els.btnLogin.disabled = false;
      els.btnLogin.textContent = "Login with Google";
      if (res && res.ok) {
        showLoggedIn();
      } else {
        setExportStatus(
          `Auth failed: ${res?.error || "Unknown error"}`,
          "error",
        );
      }
    });
  });

  els.btnLogout.addEventListener("click", () => {
    chrome.runtime.sendMessage({ type: "LOGOUT_GOOGLE" }, () => {
      showLoggedOut();
      setExportStatus("", "");
      els.sheetLink.classList.add("hidden");
    });
  });

  els.btnExport.addEventListener("click", () => {
    els.btnExport.disabled = true;
    els.btnExport.textContent = "Exporting…";
    setExportStatus("Running AI enrichment & exporting…", "info");

    chrome.runtime.sendMessage({ type: "EXPORT_TO_SHEETS" }, (res) => {
      els.btnExport.disabled = false;
      els.btnExport.textContent = "Export to Google Sheets";

      if (res && res.ok) {
        setExportStatus("Export successful!", "success");
        els.sheetLink.href = res.sheetUrl;
        els.sheetLink.classList.remove("hidden");
      } else {
        setExportStatus(
          `Export failed: ${res?.error || "Unknown error"}`,
          "error",
        );
        els.sheetLink.classList.add("hidden");
      }
      updateExportButton();
    });
  });

  // Listen for real-time data captures while popup is open
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "DATA_READY") {
      checkDataStatus();
    }
  });

  els.btnSettings.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function setExportStatus(text, level) {
  if (!text) {
    els.exportStatus.classList.add("hidden");
    return;
  }
  els.exportStatus.textContent = text;
  els.exportStatus.className = `export-status ${level}`;
  els.exportStatus.classList.remove("hidden");
}
