// lib/storage.js
// chrome.storage 包裝：sync 存設定、local 存統計與快取。
(function () {
  "use strict";

  const AITC = (globalThis.AITC = globalThis.AITC || {});

  const DEFAULT_SETTINGS = {
    enabled: true,
    platforms: { claude: true, chatgpt: true, gemini: true, deepseek: true, grok: true, perplexity: true, qwen: true },
    showSourceBadge: true, // 顯示資料來源標記（精準/估算）
    uiPosition: { right: 100, bottom: 200 }, // 浮動進度條位置
    uiCollapsed: true,
    theme: "auto", // 主題：auto（偵測頁面/系統）/ dark / light
  };

  // 速率限制設定：各平台方案（free/paid）+ 自訂值
  // custom[platformId] = { windowMs, messageLimit }（若設定則覆蓋預設）
  const DEFAULT_RATE_LIMIT_SETTINGS = {
    plans: {
      claude: "free", chatgpt: "free", gemini: "free",
      deepseek: "free", grok: "free", perplexity: "free", qwen: "free",
    },
    custom: {},
  };

  function safeSync() {
    return typeof chrome !== "undefined" && chrome.storage && chrome.storage.sync
      ? chrome.storage.sync
      : null;
  }
  function safeLocal() {
    return typeof chrome !== "undefined" && chrome.storage && chrome.storage.local
      ? chrome.storage.local
      : null;
  }

  function promisify(store, method, arg) {
    return new Promise((resolve, reject) => {
      if (!store) return resolve(method === "get" ? {} : undefined);
      try {
        store[method](arg, (res) => {
          const err = chrome.runtime.lastError;
          if (err) reject(err);
          else resolve(res);
        });
      } catch (e) {
        reject(e);
      }
    });
  }

  AITC.storage = {
    DEFAULT_SETTINGS,
    DEFAULT_RATE_LIMIT_SETTINGS,

    async getSettings() {
      const store = safeSync();
      try {
        const res = await promisify(store, "get", ["settings"]);
        return Object.assign({}, DEFAULT_SETTINGS, res.settings || {});
      } catch (_) {
        return Object.assign({}, DEFAULT_SETTINGS);
      }
    },

    async saveSettings(partial) {
      const current = await this.getSettings();
      const next = Object.assign({}, current, partial || {});
      const store = safeSync();
      await promisify(store, "set", { settings: next });
      return next;
    },

    /** 取得速率限制設定（plans + custom） */
    async getRateLimitSettings() {
      const store = safeSync();
      try {
        const res = await promisify(store, "get", ["rateLimitSettings"]);
        const saved = res.rateLimitSettings || {};
        return {
          plans: Object.assign({}, DEFAULT_RATE_LIMIT_SETTINGS.plans, saved.plans || {}),
          custom: saved.custom || {},
        };
      } catch (_) {
        return Object.assign({}, DEFAULT_RATE_LIMIT_SETTINGS);
      }
    },

    /** 儲存速率限制設定（部分更新） */
    async saveRateLimitSettings(partial) {
      const current = await this.getRateLimitSettings();
      const next = Object.assign({}, current, partial || {});
      const store = safeSync();
      await promisify(store, "set", { rateLimitSettings: next });
      return next;
    },

    async getStats(key) {
      const store = safeLocal();
      try {
        const res = await promisify(store, "get", [key]);
        return res[key] || null;
      } catch (_) {
        return null;
      }
    },

    async saveStats(key, value) {
      const store = safeLocal();
      await promisify(store, "set", { [key]: value });
      return value;
    },

    /** 當前分頁的對話計數狀態 key */
    tabStateKey(tabId, conversationId) {
      return `tabstate:${tabId || "current"}:${conversationId || "none"}`;
    },

    /** 速率限制事件時間序列 key（依平台分開儲存） */
    rateLimitEventsKey(platformId) {
      return `rl-events:${platformId || "unknown"}`;
    },

    /** 記錄一筆速率限制事件（訊息發送）
     *  event = { ts, tokens, conversationId } */
    async recordRateLimitEvent(platformId, event) {
      if (!platformId || !event) return;
      const key = this.rateLimitEventsKey(platformId);
      const store = safeLocal();
      try {
        const res = await promisify(store, "get", [key]);
        const events = Array.isArray(res[key]) ? res[key] : [];
        events.push({ ts: event.ts || Date.now(), tokens: event.tokens || 0, conversationId: event.conversationId || null });
        // 保留最近 7 天的事件（避免無限成長）
        const cutoff = Date.now() - 7 * 24 * 3600 * 1000;
        const pruned = events.filter((e) => e.ts >= cutoff);
        await promisify(store, "set", { [key]: pruned });
        return pruned;
      } catch (_) {
        return [];
      }
    },

    /** 取得指定平台的事件時間序列 */
    async getRateLimitEvents(platformId) {
      if (!platformId) return [];
      const key = this.rateLimitEventsKey(platformId);
      const store = safeLocal();
      try {
        const res = await promisify(store, "get", [key]);
        return Array.isArray(res[key]) ? res[key] : [];
      } catch (_) {
        return [];
      }
    },

    /** 清除指定平台的速率限制事件（用於撞限制後重置） */
    async clearRateLimitEvents(platformId) {
      if (!platformId) return;
      const key = this.rateLimitEventsKey(platformId);
      const store = safeLocal();
      try {
        await promisify(store, "set", { [key]: [] });
      } catch (_) {}
    },
  };
})();
