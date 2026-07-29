// options/options.js
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const DEFAULT = {
    enabled: true,
    platforms: { claude: true, chatgpt: true, gemini: true, deepseek: true, grok: true, perplexity: true, qwen: true },
    showSourceBadge: true,
    uiPosition: { right: 100, bottom: 200 },
    uiCollapsed: true,
    theme: "auto",
  };

  /** 依 theme 設定套用 body class（dark/light/auto） */
  function applyTheme(theme) {
    const body = document.body;
    body.classList.remove("theme-dark", "theme-light");
    if (theme === "dark") body.classList.add("theme-dark");
    else if (theme === "light") body.classList.add("theme-light");
    // auto：不加 class，交給 CSS media query
  }

  // 平台列表（用於平台啟停與速率限制表格）
  const PLATFORMS = [
    { id: "claude", label: "Claude", icon: "assets/icons/claude.svg", color: "#D97757" },
    { id: "chatgpt", label: "ChatGPT", icon: "assets/icons/chatgpt.svg", color: "#10A37F" },
    { id: "gemini", label: "Gemini", icon: "assets/icons/gemini.svg", color: "#4285F4" },
    { id: "deepseek", label: "DeepSeek", icon: "assets/icons/deepseek.svg", color: "#4D6BFE" },
    { id: "grok", label: "Grok", icon: "assets/icons/grok.svg", color: "#333333" },
    { id: "perplexity", label: "Perplexity", icon: "assets/icons/perplexity.svg", color: "#20B8CD" },
    { id: "qwen", label: "Qwen", icon: "assets/icons/qwen.svg", color: "#615CED" },
  ];

  // 預設速率限制（與 lib/rateLimit.js 同步）
  const RATE_LIMITS = {
    claude: { free: { windowMs: 8 * 3600 * 1000, messageLimit: 30 }, paid: { windowMs: 5 * 3600 * 1000, messageLimit: 100 } },
    chatgpt: { free: { windowMs: 3 * 3600 * 1000, messageLimit: 40 }, paid: { windowMs: 3 * 3600 * 1000, messageLimit: 80 } },
    gemini: { free: { windowMs: 24 * 3600 * 1000, messageLimit: 1500 }, paid: { windowMs: 24 * 3600 * 1000, messageLimit: 0 } },
    deepseek: { free: { windowMs: 24 * 3600 * 1000, messageLimit: 50 }, paid: { windowMs: 24 * 3600 * 1000, messageLimit: 500 } },
    grok: { free: { windowMs: 1 * 3600 * 1000, messageLimit: 13 }, paid: { windowMs: 1 * 3600 * 1000, messageLimit: 0 } },
    perplexity: { free: { windowMs: 4 * 3600 * 1000, messageLimit: 5 }, paid: { windowMs: 4 * 3600 * 1000, messageLimit: 300 } },
    qwen: { free: { windowMs: 24 * 3600 * 1000, messageLimit: 50 }, paid: { windowMs: 24 * 3600 * 1000, messageLimit: 0 } },
  };

  let settings = Object.assign({}, DEFAULT);
  let rlSettings = {
    plans: { claude: "free", chatgpt: "free", gemini: "free", deepseek: "free", grok: "free", perplexity: "free", qwen: "free" },
    custom: {},
  };

  /** 建立平台啟停清單（含 logo） */
  function buildPlatformList() {
    const container = $("platformList");
    container.innerHTML = "";
    for (const p of PLATFORMS) {
      const label = document.createElement("label");
      label.className = "platform-item";
      label.innerHTML =
        '<input type="checkbox" id="p-' + p.id + '" />' +
        '<img src="../' + p.icon + '" alt="" class="platform-logo" />' +
        '<span class="platform-name">' + p.label + '</span>';
      container.appendChild(label);
    }
  }

  /** 動態收集平台啟停狀態 */
  function collectPlatforms() {
    const out = {};
    for (const p of PLATFORMS) {
      const el = $("p-" + p.id);
      out[p.id] = el ? el.checked : true;
    }
    return out;
  }

  // 即時持久化目前表單狀態
  function persist() {
    settings.enabled = $("enabled").checked;
    settings.showSourceBadge = $("showSourceBadge").checked;
    settings.theme = $("theme").value;
    settings.platforms = collectPlatforms();
    chrome.storage.sync.set({ settings });
  }

  /** 持久化速率限制設定 */
  function persistRateLimit() {
    // 收集表格中的值
    const plans = {};
    const custom = {};
    for (const p of PLATFORMS) {
      const planSel = $("plan-" + p.id);
      const windowInput = $("window-" + p.id);
      const limitInput = $("limit-" + p.id);
      if (planSel) plans[p.id] = planSel.value;
      // 自訂值：僅在與預設值不同時儲存
      const base = RATE_LIMITS[p.id][planSel ? planSel.value : "free"];
      const windowH = windowInput ? parseFloat(windowInput.value) : NaN;
      const limit = limitInput ? parseInt(limitInput.value, 10) : NaN;
      const customEntry = {};
      if (!isNaN(windowH) && windowH > 0) {
        const windowMs = windowH * 3600 * 1000;
        if (windowMs !== base.windowMs) customEntry.windowMs = windowMs;
      }
      if (!isNaN(limit)) {
        if (limit !== base.messageLimit) customEntry.messageLimit = limit;
      }
      if (Object.keys(customEntry).length > 0) custom[p.id] = customEntry;
    }
    rlSettings.plans = plans;
    rlSettings.custom = custom;
    chrome.storage.sync.set({ rateLimitSettings: rlSettings });
  }

  function flashSaved(msg) {
    const s = $("saved");
    s.textContent = msg || "已儲存";
    s.hidden = false;
    clearTimeout(s._timer);
    s._timer = setTimeout(() => (s.hidden = true), 3000);
  }

  /** 建立速率限制表格 */
  function buildRateLimitTable() {
    const tbody = $("rlTbody");
    tbody.innerHTML = "";
    for (const p of PLATFORMS) {
      const tr = document.createElement("tr");
      const plan = rlSettings.plans[p.id] || "free";
      const custom = rlSettings.custom[p.id] || {};
      const base = RATE_LIMITS[p.id][plan];
      const windowMs = custom.windowMs != null ? custom.windowMs : base.windowMs;
      const messageLimit = custom.messageLimit != null ? custom.messageLimit : base.messageLimit;
      const windowH = (windowMs / 3600000).toString();

      tr.innerHTML =
        '<td class="rl-platform-cell">' +
          '<img src="../' + p.icon + '" alt="" class="platform-logo" />' +
          '<span>' + p.label + '</span>' +
        '</td>' +
        '<td><select id="plan-' + p.id + '">' +
          '<option value="free"' + (plan === "free" ? " selected" : "") + '>免費</option>' +
          '<option value="paid"' + (plan === "paid" ? " selected" : "") + '>付費</option>' +
        '</select></td>' +
        '<td><input type="number" id="window-' + p.id + '" min="0.1" step="0.5" value="' + windowH + '" /></td>' +
        '<td><input type="number" id="limit-' + p.id + '" min="0" step="1" value="' + messageLimit + '" /></td>';
      tbody.appendChild(tr);

      // 方案切換時更新視窗與限制為該方案預設值
      $("plan-" + p.id).addEventListener("change", (e) => {
        const newPlan = e.target.value;
        const newBase = RATE_LIMITS[p.id][newPlan];
        $("window-" + p.id).value = newBase.windowMs / 3600000;
        $("limit-" + p.id).value = newBase.messageLimit;
        persistRateLimit();
        flashSaved();
      });
      // 數值變更即儲存
      $("window-" + p.id).addEventListener("change", () => { persistRateLimit(); flashSaved(); });
      $("limit-" + p.id).addEventListener("change", () => { persistRateLimit(); flashSaved(); });
    }
  }

  /** 重置為預設值 */
  function resetRateLimit() {
    rlSettings = {
      plans: { claude: "free", chatgpt: "free", gemini: "free", deepseek: "free", grok: "free", perplexity: "free", qwen: "free" },
      custom: {},
    };
    chrome.storage.sync.set({ rateLimitSettings: rlSettings });
    buildRateLimitTable();
    flashSaved("已重置為預設值");
  }

  /** 清除速率限制歷史事件 */
  function clearRateLimitEvents() {
    if (!confirm("確定清除所有平台的速率限制歷史？此操作無法復原。")) return;
    const keys = PLATFORMS.map((p) => "rl-events:" + p.id);
    chrome.storage.local.remove(keys, () => {
      flashSaved("已清除速率限制歷史");
    });
  }

  chrome.storage.sync.get(["settings", "rateLimitSettings"], (res) => {
    settings = Object.assign({}, DEFAULT, res.settings || {});
    if (res.rateLimitSettings) {
      rlSettings = Object.assign({}, rlSettings, res.rateLimitSettings);
      rlSettings.plans = Object.assign({ claude: "free", chatgpt: "free", gemini: "free", deepseek: "free", grok: "free", perplexity: "free", qwen: "free" }, res.rateLimitSettings.plans || {});
      rlSettings.custom = res.rateLimitSettings.custom || {};
    }
    $("enabled").checked = settings.enabled !== false;
    $("showSourceBadge").checked = settings.showSourceBadge !== false;
    $("theme").value = settings.theme || "auto";
    applyTheme(settings.theme || "auto");
    buildPlatformList();
    // 套用已儲存的平台啟停狀態
    for (const p of PLATFORMS) {
      const el = $("p-" + p.id);
      if (el) el.checked = settings.platforms[p.id] !== false;
    }
    buildRateLimitTable();
  });

  // 所有欄位 change 即儲存（auto-save）
  ["enabled", "showSourceBadge"].forEach((id) => {
    $(id).addEventListener("change", () => {
      persist();
      flashSaved();
    });
  });
  // 平台啟停：事件委派給容器（動態生成的 checkbox）
  $("platformList").addEventListener("change", (e) => {
    if (e.target.matches('input[type="checkbox"]')) {
      persist();
      flashSaved();
    }
  });

  // 主題切換：即時套用 + 儲存
  $("theme").addEventListener("change", () => {
    persist();
    applyTheme(settings.theme);
    flashSaved();
  });

  $("rlReset").addEventListener("click", resetRateLimit);
  $("rlClearEvents").addEventListener("click", clearRateLimitEvents);

  $("resetPos").addEventListener("click", () => {
    settings.uiPosition = { right: 100, bottom: 200 };
    settings.uiCollapsed = true;
    // 立即儲存使內容腳本可讀取（雖需重整頁面生效）
    persist();
    flashSaved("已儲存，請重新整理分頁生效");
  });
})();
