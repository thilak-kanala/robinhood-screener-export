// ── Bridge Script – ISOLATED world ──
// Listens for custom DOM events from the MAIN-world content script
// and relays them to the background service worker via chrome.runtime.

window.addEventListener("__RH_SCREENER_PAYLOAD__", (event) => {
  try {
    const payload =
      typeof event.detail === "string"
        ? JSON.parse(event.detail)
        : event.detail;

    chrome.runtime.sendMessage(
      { type: "SCREENER_PAYLOAD", payload },
      (response) => {
        if (chrome.runtime.lastError) {
          console.warn(
            "[RH Export Bridge] sendMessage error:",
            chrome.runtime.lastError.message,
          );
        } else if (response && response.count > 0) {
          console.log(
            `[RH Screener Export] Captured ${response.count} stocks.`,
          );
        }
      },
    );
  } catch (e) {
    console.warn("[RH Export Bridge] Failed to relay payload:", e);
  }
});
