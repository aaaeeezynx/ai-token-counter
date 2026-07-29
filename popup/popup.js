// popup/popup.js
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);

  // 平台 id → 顯示名稱（與 lib/platforms.js 同步）
  const PLATFORM_LABELS = {
    claude: "Claude",
    chatgpt: "ChatGPT",
    gemini: "Gemini",
    deepseek: "DeepSeek",
    grok: "Grok",
    perplexity: "Perplexity",
    qwen: "Qwen",
  };

  function fmt(n) {
    return n == null || isNaN(n) ? "—" : Math.round(n).toLocaleString("en-US");
  }

  /** 依 settings.platforms 動態列出已啟用平台，未設定時列出全部 */
  function updateSupportedList(platforms) {
    const enabled = Object.keys(PLATFORM_LABELS)
      .filter((k) => !platforms || platforms[k] !== false)
      .map((k) => PLATFORM_LABELS[k]);
    $("vSupported").textContent = enabled.join("、");
  }

  chrome.storage.sync.get(["settings"], (res) => {
    const settings = res.settings || { enabled: true };
    $("enabledToggle").checked = settings.enabled !== false;
    updateSupportedList(settings.platforms);
    // 套用主題並設定 toggle 開關位置
    const theme = settings.theme || "auto";
    applyThemeToBody(theme);
    syncThemeToggle(theme);
  });

  /** 將主題套用至 body */
  function applyThemeToBody(theme) {
    document.body.classList.remove("theme-dark", "theme-light");
    if (theme === "dark") document.body.classList.add("theme-dark");
    else if (theme === "light") document.body.classList.add("theme-light");
  }

  /** 依主題設定 toggle checkbox 的 checked 狀態（checked=深色） */
  function syncThemeToggle(theme) {
    let isDark;
    if (theme === "dark") isDark = true;
    else if (theme === "light") isDark = false;
    else {
      // auto：依系統偏好
      isDark = !window.matchMedia("(prefers-color-scheme: light)").matches;
    }
    $("themeToggle").checked = isDark;
  }

  // 太陽/月亮滑動開關：change 事件切換深淺色
  $("themeToggle").addEventListener("change", (e) => {
    const next = e.target.checked ? "dark" : "light";
    chrome.storage.sync.get(["settings"], (res) => {
      const settings = res.settings || {};
      settings.theme = next;
      chrome.storage.sync.set({ settings });
      applyThemeToBody(next);
    });
  });

  $("enabledToggle").addEventListener("change", (e) => {
    chrome.storage.sync.get(["settings"], (res) => {
      const settings = res.settings || {};
      settings.enabled = e.target.checked;
      chrome.storage.sync.set({ settings });
    });
  });

  $("btnOptions").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
  });

  // 兩段式重置：第一次點擊變「確認重置？」並變紅，3 秒內再點才執行；逾時自動復原
  let resetArmed = false;
  let resetTimer = null;
  $("btnReset").addEventListener("click", () => {
    if (!resetArmed) {
      resetArmed = true;
      const btn = $("btnReset");
      btn.textContent = "確認重置？";
      btn.classList.add("danger");
      clearTimeout(resetTimer);
      resetTimer = setTimeout(() => {
        resetArmed = false;
        btn.textContent = "重置當前對話";
        btn.classList.remove("danger");
      }, 3000);
      return;
    }
    // 第二次點擊：執行重置
    clearTimeout(resetTimer);
    resetArmed = false;
    const btn = $("btnReset");
    btn.textContent = "重置當前對話";
    btn.classList.remove("danger");
    chrome.runtime.sendMessage({ type: "popup-reset" }, () => {
      loadStatus();
    });
  });

  function loadStatus() {
    chrome.runtime.sendMessage({ type: "popup-get-status" }, (resp) => {
      if (chrome.runtime.lastError || !resp || !resp.status) {
        $("statusBox").hidden = true;
        $("noAi").hidden = false;
        return;
      }
      const s = resp.status;
      $("noAi").hidden = true;
      $("statusBox").hidden = false;
      $("vPlatform").textContent = s.platformLabel || "—";
      $("vUsage").textContent =
        fmt(s.used) + " / " + fmt(s.contextWindow);
      $("vPct").textContent =
        s.contextWindow > 0
          ? ((s.used / s.contextWindow) * 100).toFixed(1) + "%"
          : "—";
      $("vSource").textContent =
        s.source === "intercept"
          ? "精準（攔截）"
          : s.source === "estimate"
          ? "估算"
          : "—";
    });
  }

  loadStatus();
})();
