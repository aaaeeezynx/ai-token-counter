// lib/rateLimit.js
// 各平台速率限制預設值（免費/付費版）+ 查詢 API。
// 預設值為社群觀測值（會變動），使用者可在 options 頁手動調整。
// 設計：以「訊息數限制」為主（官方多用此指標），並透過歷史平均 token/則 推算等效 token 上限。
// 視窗：每個平台定義一個主要滾動窗口（如 Claude 8h、ChatGPT 3h）。
(function () {
  "use strict";

  const AITC = (globalThis.AITC = globalThis.AITC || {});

  // 預設速率限制（社群觀測值，僅供參考）
  // messageLimit = 0 表示無限制（付費版常見）
  const RATE_LIMITS = {
    claude: {
      label: "Claude",
      free: { windowMs: 8 * 3600 * 1000, messageLimit: 30 },
      paid: { windowMs: 5 * 3600 * 1000, messageLimit: 100 },
    },
    chatgpt: {
      label: "ChatGPT",
      free: { windowMs: 3 * 3600 * 1000, messageLimit: 40 },
      paid: { windowMs: 3 * 3600 * 1000, messageLimit: 80 },
    },
    gemini: {
      label: "Gemini",
      free: { windowMs: 24 * 3600 * 1000, messageLimit: 1500 },
      paid: { windowMs: 24 * 3600 * 1000, messageLimit: 0 },
    },
    deepseek: {
      label: "DeepSeek",
      free: { windowMs: 24 * 3600 * 1000, messageLimit: 50 },
      paid: { windowMs: 24 * 3600 * 1000, messageLimit: 500 },
    },
    grok: {
      label: "Grok",
      free: { windowMs: 1 * 3600 * 1000, messageLimit: 13 },
      paid: { windowMs: 1 * 3600 * 1000, messageLimit: 0 },
    },
    perplexity: {
      label: "Perplexity",
      free: { windowMs: 4 * 3600 * 1000, messageLimit: 5 },
      paid: { windowMs: 4 * 3600 * 1000, messageLimit: 300 },
    },
    qwen: {
      label: "Qwen",
      free: { windowMs: 24 * 3600 * 1000, messageLimit: 50 },
      paid: { windowMs: 24 * 3600 * 1000, messageLimit: 0 },
    },
  };

  // 預設方案：全部設為免費版（保守估計）
  const DEFAULT_PLANS = {
    claude: "free",
    chatgpt: "free",
    gemini: "free",
    deepseek: "free",
    grok: "free",
    perplexity: "free",
    qwen: "free",
  };

  AITC.rateLimit = {
    RATE_LIMITS,
    DEFAULT_PLANS,

    /** 取得指定平台的速率限制定義（含 window 與 messageLimit）
     *  優先序：使用者自訂 > 預設值
     *  settings 為 storage 取得的 rateLimitSettings 物件 */
    getLimit(platformId, settings) {
      if (!platformId) return null;
      const cfg = RATE_LIMITS[platformId];
      if (!cfg) return null;
      const plan =
        settings && settings.plans && settings.plans[platformId]
          ? settings.plans[platformId]
          : DEFAULT_PLANS[platformId] || "free";
      const base = cfg[plan] || cfg.free;
      if (!base) return null;

      // 使用者自訂覆蓋
      const custom =
        settings && settings.custom && settings.custom[platformId];
      const windowMs =
        custom && custom.windowMs != null && custom.windowMs > 0
          ? custom.windowMs
          : base.windowMs;
      const messageLimit =
        custom && custom.messageLimit != null
          ? custom.messageLimit
          : base.messageLimit;

      return {
        platformId,
        plan,
        windowMs,
        messageLimit,
        label: cfg.label,
      };
    },

    /** 由時間序列計算當前窗口內的使用量
     *  events: [{ ts, tokens, platformId }]
     *  回傳 { count, totalTokens, windowStart, resetInMs } */
    computeUsage(events, limit) {
      if (!events || !limit || limit.windowMs <= 0) {
        return { count: 0, totalTokens: 0, windowStart: 0, resetInMs: 0 };
      }
      const now = Date.now();
      const windowStart = now - limit.windowMs;
      // 過濾窗口內事件
      const inWindow = events.filter(
        (e) => e.ts >= windowStart && e.ts <= now
      );
      const count = inWindow.length;
      const totalTokens = inWindow.reduce((s, e) => s + (e.tokens || 0), 0);
      // 重置時間 = 最早事件 + windowMs（滾動窗口）
      const resetInMs =
        count > 0
          ? Math.max(0, inWindow[0].ts + limit.windowMs - now)
          : 0;
      return { count, totalTokens, windowStart, resetInMs };
    },

    /** 計算消耗速率與預估觸發時間
     *  回傳 { tokensPerMin, msgsPerMin, etaMin, remainingMsgs, remainingTokens } */
    predict(events, limit, usage) {
      if (!limit || limit.messageLimit <= 0) {
        return {
          tokensPerMin: 0,
          msgsPerMin: 0,
          etaMin: null,
          remainingMsgs: 0,
          remainingTokens: 0,
        };
      }
      const now = Date.now();
      const windowStart = now - limit.windowMs;
      const inWindow = events.filter(
        (e) => e.ts >= windowStart && e.ts <= now
      );
      const count = inWindow.length;
      const totalTokens = inWindow.reduce((s, e) => s + (e.tokens || 0), 0);

      // 速率：以窗口內最早事件到現在的時間跨度計算
      const spanMs =
        count > 1 ? now - inWindow[0].ts : limit.windowMs;
      const spanMin = Math.max(1, spanMs / 60000);
      const msgsPerMin = count / spanMin;
      const tokensPerMin = totalTokens / spanMin;

      const remainingMsgs = Math.max(0, limit.messageLimit - count);
      // 等效 token 上限 = 平均每則 token × messageLimit
      const avgTokensPerMsg = count > 0 ? totalTokens / count : 0;
      const tokenLimitEq = Math.round(avgTokensPerMsg * limit.messageLimit);
      const remainingTokens = Math.max(
        0,
        tokenLimitEq - totalTokens
      );

      // 預估觸發時間（分鐘）
      let etaMin = null;
      if (msgsPerMin > 0 && remainingMsgs > 0) {
        etaMin = remainingMsgs / msgsPerMin;
      }

      return {
        tokensPerMin,
        msgsPerMin,
        etaMin,
        remainingMsgs,
        remainingTokens,
        tokenLimitEq,
        avgTokensPerMsg,
      };
    },

    /** 視窗時長人類可讀字串 */
    formatWindow(windowMs) {
      const h = windowMs / 3600000;
      if (h >= 1 && h === Math.floor(h)) return h + " 小時";
      const m = windowMs / 60000;
      if (m >= 1) return m + " 分";
      return (windowMs / 1000) + " 秒";
    },

    /** 重置時間人類可讀字串 */
    formatReset(resetInMs) {
      if (resetInMs <= 0) return "—";
      const min = Math.ceil(resetInMs / 60000);
      if (min < 60) return min + " 分";
      const h = Math.floor(min / 60);
      const m = min % 60;
      return h + "h " + m + "m";
    },
  };
})();
