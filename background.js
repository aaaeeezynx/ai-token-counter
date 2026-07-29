// background.js
// Service Worker：安裝時寫入預設設定、接收 content 狀態、回應 popup 查詢。
(function () {
  "use strict";

  const DEFAULT_SETTINGS = {
    enabled: true,
    platforms: { claude: true, chatgpt: true, gemini: true, deepseek: true, grok: true, perplexity: true, qwen: true },
    showSourceBadge: true,
    uiPosition: { right: 100, bottom: 200 },
    uiCollapsed: true,
  };

  function getSettings() {
    return new Promise((resolve) => {
      try {
        chrome.storage.sync.get(["settings"], (res) => {
          resolve(Object.assign({}, DEFAULT_SETTINGS, res.settings || {}));
        });
      } catch (_) {
        resolve(Object.assign({}, DEFAULT_SETTINGS));
      }
    });
  }

  // ---- 安裝 / 啟動：寫入預設設定 ----
  chrome.runtime.onInstalled.addListener(async () => {
    try {
      const cur = await new Promise((r) =>
        chrome.storage.sync.get(["settings"], r)
      );
      if (!cur.settings) {
        chrome.storage.sync.set({ settings: DEFAULT_SETTINGS });
      }
    } catch (_) {}
  });

  // ---- 來自 content 的訊息 ----
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg) return;
    const tabId = sender.tab && sender.tab.id;

    // content 回報最新狀態（保留作為分頁狀態快取，供未來擴充使用）
    if (msg.type === "status") {
      sendResponse && sendResponse({ ok: true });
      return false;
    }

    // popup 查詢當前分頁狀態
    if (msg.type === "popup-get-status") {
      (async () => {
        try {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          if (!tab || !tab.id) return sendResponse({ status: null });
          chrome.tabs.sendMessage(
            tab.id,
            { type: "get-status" },
            (resp) => {
              if (chrome.runtime.lastError) sendResponse({ status: null });
              else sendResponse({ status: resp || null });
            }
          );
        } catch (_) {
          sendResponse({ status: null });
        }
      })();
      return true; // async
    }

    // popup 重置當前對話計數
    if (msg.type === "popup-reset") {
      (async () => {
        try {
          const [tab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          if (!tab || !tab.id) return sendResponse({ ok: false });
          chrome.tabs.sendMessage(tab.id, { type: "reset-current" }, (resp) => {
            if (chrome.runtime.lastError) sendResponse({ ok: false });
            else sendResponse({ ok: true });
          });
        } catch (_) {
          sendResponse({ ok: false });
        }
      })();
      return true;
    }

    return false;
  });
})();
