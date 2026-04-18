// ── Content Script – Injected into MAIN world on robinhood.com ──
// Intercepts fetch/XHR responses to capture screener API payloads
// and forwards them to the background service worker.

(function () {
  "use strict";

  const SCREENER_PATTERNS = [/screener/i, /midlands.*results/i, /dora.*fetch/i];

  function isScreenerUrl(url) {
    return SCREENER_PATTERNS.some((p) => p.test(url));
  }

  function forwardPayload(payload) {
    try {
      // postMessage to the ISOLATED world content script won't work since we're
      // in MAIN world. Use a custom DOM event to bridge to the extension context.
      window.dispatchEvent(
        new CustomEvent("__RH_SCREENER_PAYLOAD__", {
          detail:
            typeof payload === "string" ? payload : JSON.stringify(payload),
        }),
      );
    } catch (e) {
      console.warn("[RH Export] Could not forward payload:", e);
    }
  }

  // ── Patch fetch ─────────────────────────────────────────────────────────────
  const originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      if (isScreenerUrl(url)) {
        // Clone so the app can still read the body
        const clone = response.clone();
        clone
          .json()
          .then((json) => forwardPayload(json))
          .catch(() => {});
      }
    } catch (_) {
      // Non-critical – never break the host page
    }
    return response;
  };

  // ── Patch XMLHttpRequest ────────────────────────────────────────────────────
  const XHROpen = XMLHttpRequest.prototype.open;
  const XHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__rhUrl = url;
    return XHROpen.call(this, method, url, ...rest);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (this.__rhUrl && isScreenerUrl(this.__rhUrl)) {
      this.addEventListener("load", function () {
        try {
          const json = JSON.parse(this.responseText);
          forwardPayload(json);
        } catch (_) {}
      });
    }
    return XHRSend.apply(this, args);
  };

  console.log("[RH Screener Export] Network interceptor active.");
})();
