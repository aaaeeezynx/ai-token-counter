// lib/ui.js
// 浮動 Shadow DOM 進度條 UI。圓形收合模式 + Morph 方向性動畫。
// 設計：80×80 圓形收合（logo 50×50 + 6px 圓環進度條，無底色外圈），點擊展開為詳細模式。
// 動畫：0.3s/phase 方向性 — 展開先向下(height)再往右(width)，收合先向左(width)再向上(height)。
// 文字：展開後淡入(0.2s)、收合前淡出(0.2s)。過渡保持長方形圓角，收合完成才變圓形。
// 收合模式支援拖曳移動（4px threshold 區分點擊與拖曳）。
(function () {
  "use strict";

  const AITC = (globalThis.AITC = globalThis.AITC || {});

  let host = null;
  let shadow = null;
  let els = {};
  let dragState = null;
  let suppressClick = false;
  let lastState = null;

  // 平台品牌色（用於 currentColor 控制）與 SVG 圖示路徑
  // SVG 來源：lobehub/lobe-icons (https://lobehub.com/icons)
  const PLATFORM_LOGOS = {
    claude: { color: "#D97757", icon: "assets/icons/claude.svg" },
    chatgpt: { color: "#10A37F", icon: "assets/icons/chatgpt.svg" },
    gemini: { color: "#4285F4", icon: "assets/icons/gemini.svg" },
    deepseek: { color: "#4D6BFE", icon: "assets/icons/deepseek.svg" },
    grok: { color: "#333333", icon: "assets/icons/grok.svg" },
    perplexity: { color: "#20B8CD", icon: "assets/icons/perplexity.svg" },
    qwen: { color: "#615CED", icon: "assets/icons/qwen.svg" },
  };
  // SVG 內容快取（非同步載入後填入）
  const iconCache = {};

  // 預設位置：距底邊 200px、右邊 100px
  const DEFAULT_POS = { right: 100, bottom: 200 };
  const COMPACT_BREAKPOINT = 700;
  // 雙進度條 SVG 參數（viewBox 100×100，容器 80×80）：
  // 外圈（速率限制）：r=38, W=4 — 外緣距容器邊約 4px
  // 內圈（上下文）：r=30, W=4 — 與外圈間距約 3px
  // logo：34×34, top/left 23px — 與內圈間距約 5px
  const RING_R = 30;            // 內圈（上下文使用量）
  const RING_CIRCUMFERENCE = 2 * Math.PI * RING_R;
  const RATE_RING_R = 38;       // 外圈（速率限制）
  const RATE_RING_CIRCUMFERENCE = 2 * Math.PI * RATE_RING_R;

  // 配色（Nippon Colors 規範）
  // 上下文使用量：低=瑠璃 #175DCF（飽和度提升版）→ 中=山吹 #F8B500 → 高=韓紅花 #D0104C
  // 速率限制：低=常磐 #007B43 → 中=山吹 #F8B500 → 高=韓紅花 #D0104C
  function ctxColor(pct) {
    if (pct >= 90) return "#D0104C"; // 韓紅花 KARAKURENAI（臨界）
    if (pct >= 70) return "#F8B500"; // 山吹 YAMABUKI（警告）
    return "#175DCF"; // 瑠璃 RURI（起始，飽和度提升版）
  }
  function rateColor(pct) {
    if (pct >= 90) return "#D0104C"; // 韓紅花 KARAKURENAI（臨界）
    if (pct >= 70) return "#F8B500"; // 山吹 YAMABUKI（警告）
    return "#007B43"; // 常磐 TOKIWA（起始）
  }
  // 模式字體顏色（Nippon Colors — 加深色階確保深淺色模式皆可讀）
  const MODE_COLORS = {
    intercept: "#5DAC81", // 若竹 WAKATAKE（精準模式）
    estimate: "#D9AB42",  // 雌黄 SHIO（估算模式）
  };

  function fmt(n) {
    if (n == null || isNaN(n)) return "—";
    return Math.round(n).toLocaleString("en-US");
  }

  function getLogo(platformId) {
    return PLATFORM_LOGOS[platformId] || { color: "#91989F", icon: null };
  }

  /** 非同步載入平台 SVG 圖示並快取；currentColor 會替換為品牌色 */
  async function loadIcon(platformId) {
    if (iconCache[platformId]) return iconCache[platformId];
    const logo = PLATFORM_LOGOS[platformId];
    if (!logo || !logo.icon) return null;
    try {
      const url = chrome.runtime.getURL(logo.icon);
      const res = await fetch(url);
      let svg = await res.text();
      // 將 currentColor 替換為品牌色，確保用 <img> 載入時也正確顯示
      svg = svg.replace(/currentColor/gi, logo.color);
      iconCache[platformId] = svg;
      return svg;
    } catch (e) {
      return null;
    }
  }

  /** 一律重設至預設位置（右下角） */
  function applyDefaultPosition() {
    if (!host) return;
    host.style.right = DEFAULT_POS.right + "px";
    host.style.bottom = DEFAULT_POS.bottom + "px";
    host.style.left = "auto";
    host.style.top = "auto";
  }

  /** 拖曳時限制在視窗可見範圍內 */
  function clampPosition(left, top) {
    const w = (host && host.offsetWidth) || 80;
    const h = (host && host.offsetHeight) || 80;
    const margin = 4;
    const maxLeft = Math.max(margin, window.innerWidth - w - margin);
    const maxTop = Math.max(margin, window.innerHeight - h - margin);
    return {
      left: Math.max(margin, Math.min(left, maxLeft)),
      top: Math.max(margin, Math.min(top, maxTop)),
    };
  }

  /**
   * 套用主題至浮動 UI。
   * - theme="dark" / "light"：強制指定
   * - theme="auto"（預設）：偵測頁面背景色亮度決定
   *   取 document.body 與 documentElement 的背景色，取第一個有效值；
   *   以相對亮度（ITU-R BT.709）判斷，> 0.5 視為淺色背景。
   */
  function applyTheme(theme) {
    if (!els.wrap) return;
    let isLight = false;
    if (theme === "dark") {
      isLight = false;
    } else if (theme === "light") {
      isLight = true;
    } else {
      // auto：偵測頁面背景
      let bg = null;
      try {
        const candidates = [document.body, document.documentElement];
        for (const el of candidates) {
          if (!el) continue;
          const c = getComputedStyle(el).backgroundColor;
          if (c && c !== "rgba(0, 0, 0, 0)" && c !== "transparent") {
            bg = c;
            break;
          }
        }
      } catch (_) {}
      if (bg) {
        const m = bg.match(/\d+(\.\d+)?/g);
        if (m && m.length >= 3) {
          const [r, g, b] = m.map(Number);
          // ITU-R BT.709 相對亮度（gamma 近似）
          const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
          isLight = lum > 0.5;
        }
      }
    }
    els.wrap.classList.toggle("theme-light", isLight);
    els.wrap.classList.toggle("theme-dark", !isLight);
  }

  /** 視窗寬度 < 700px 時強制收合 + compact 顯示 */
  function checkCompactMode() {
    if (!els.wrap) return;
    if (window.innerWidth < COMPACT_BREAKPOINT) {
      els.wrap.classList.add("compact", "collapsed");
    } else {
      els.wrap.classList.remove("compact");
    }
    // compact 切換後重新套用 ring/compactDot 顏色
    applyRingColors();
  }

  /** 根據當前 compact 狀態和 lastState 套用 ring 與模式圓點顏色 */
  function applyRingColors() {
    if (!els.ringFill) return;
    const used = (lastState && lastState.used) || 0;
    const limit = (lastState && lastState.contextWindow) || 0;
    const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
    const isIntercept = lastState && lastState.source === "intercept";
    const modeColor = isIntercept ? MODE_COLORS.intercept : MODE_COLORS.estimate;
    const levelColor = ctxColor(pct);
    // 內圈統一用 levelColor（收合/展開/compact 一致）；模式色僅用於 compact-dot 與 badge
    els.ringFill.style.stroke = levelColor;
    if (els.compactDot && els.wrap.classList.contains("compact")) {
      els.compactDot.style.background = modeColor;
    }
    // 速率限制外圈：收合/展開統一用 rateColor
    if (els.ringRate && lastState && lastState.rateLimitUsage && lastState.rateLimit) {
      const rlCount = lastState.rateLimitUsage.count || 0;
      const rlLimit = lastState.rateLimit.messageLimit || 0;
      const rlPct = rlLimit > 0 ? Math.min(100, (rlCount / rlLimit) * 100) : 0;
      els.ringRate.style.stroke = rateColor(rlPct);
    }
  }

  function buildDom() {
    host = document.createElement("div");
    host.id = "aitc-host";
    host.style.cssText =
      "all:initial;position:fixed;z-index:2147483647;right:" +
      DEFAULT_POS.right + "px;bottom:" + DEFAULT_POS.bottom + "px;";
    shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = `
      @import url('https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700&display=swap');
      :host, * { box-sizing: border-box; font-family: 'Noto Sans JP', -apple-system, "Segoe UI", "Microsoft JhengHei", sans-serif; }

      /* 主題變數：預設黑色模式（黒橡 #0B1013）；.theme-light 覆寫為白色模式（白練 #FCFAF2）
         字體顏色使用背景色的互補色（黑色模式用胡粉 #FFFFFB，白色模式用 #1A1715）
         Nippon Colors 規範 — 蘇芳/瑠璃/常磐/山吹/韓紅花 等傳統色名 */
      .wrap {
        --aitc-bg: #0B1013;
        --aitc-bg-collapse: rgba(11,16,19,0.10);
        --aitc-fg: #FFFFFB;
        --aitc-fg-muted: rgba(255,255,251,0.6);
        --aitc-fg-dim: rgba(255,255,251,0.35);
        --aitc-fg-bright: rgba(255,255,251,0.9);
        --aitc-surface: rgba(255,255,251,0.12);
        --aitc-surface-2: rgba(255,255,251,0.08);
        --aitc-logo-bg: #0B1013;
        --aitc-logo-shadow: inset 0 1px 4px rgba(255,255,251,0.15);
        --aitc-shimmer: rgba(255,255,251,0.18);
        --aitc-bar-bg: rgba(255,255,251,0.12);
        /* 進度條配色（兩種模式一致） */
        --aitc-ctx-color: #175DCF;   /* 瑠璃 RURI — 上下文使用量起始色（飽和度提升版） */
        --aitc-rate-color: #007B43;  /* 常磐 TOKIWA — 速率限制色 */
        --aitc-warn: #F8B500;        /* 山吹 YAMABUKI — 警告 */
        --aitc-critical: #D0104C;    /* 韓紅花 KARAKURENAI — 臨界 */
        --aitc-intercept: #5DAC81;   /* 若竹 WAKATAKE — 精準模式字體 */
        --aitc-estimate: #D9AB42;    /* 雌黄 SHIO — 估算模式字體 */
      }
      .wrap.theme-light {
        --aitc-bg: #FCFAF2;
        --aitc-bg-collapse: rgba(252,250,242,0.03);
        --aitc-fg: #1A1715;
        --aitc-fg-muted: rgba(26,23,21,0.65);
        --aitc-fg-dim: rgba(26,23,21,0.5);
        --aitc-fg-bright: rgba(26,23,21,0.95);
        --aitc-surface: rgba(26,23,21,0.1);
        --aitc-surface-2: rgba(26,23,21,0.1);
        --aitc-logo-bg: #FCFAF2;
        --aitc-logo-shadow: inset 0 1px 4px rgba(0,0,0,0.1);
        --aitc-shimmer: rgba(26,23,21,0.12);
        --aitc-bar-bg: rgba(26,23,21,0.1);
      }

      /* === 容器：Morph 方向性動畫 (0.3s/phase) ===
         展開（target=.wrap）：先向下 height(0s) → 再往右 width(.3s)
         收合（target=.wrap.collapsed）：先向左 width(.2s) → 再向上 height(.5s)
         文字：展開後淡入(.6s delay)、收合前淡出(0s delay)，各 0.2s
         形狀：過渡中保持長方形圓角(12px)，收合完成才變圓形(50%) */
      .wrap {
        position: relative;
        width: 280px; height: 215px;
        background: var(--aitc-bg); color: var(--aitc-fg);
        border-radius: 12px; padding: 12px 14px; box-shadow: 0 6px 16px rgba(11,16,19,.10);
        backdrop-filter: blur(6px); user-select: none; cursor: move;
        font-size: 12px; line-height: 1.4; overflow: hidden;
        transition: width .3s cubic-bezier(0.65, 0, 0.35, 1) .3s,
                    height .3s cubic-bezier(0.65, 0, 0.35, 1) 0s,
                    border-radius .1s cubic-bezier(0.65, 0, 0.35, 1) 0s,
                    padding .3s cubic-bezier(0.65, 0, 0.35, 1) 0s,
                    background .1s linear 0s,
                    box-shadow .1s linear 0s,
                    backdrop-filter .1s linear 0s;
      }
      .wrap.collapsed {
        width: 80px; height: 80px;
        border-radius: 50%; padding: 0;
        background: transparent;
        box-shadow: 0 6px 16px rgba(11,16,19,.10); backdrop-filter: none;
        transition: width .3s cubic-bezier(0.65, 0, 0.35, 1) .2s,
                    height .3s cubic-bezier(0.65, 0, 0.35, 1) .5s,
                    border-radius .1s cubic-bezier(0.65, 0, 0.35, 1) .7s,
                    padding .3s cubic-bezier(0.65, 0, 0.35, 1) .2s,
                    background .1s linear .7s,
                    box-shadow .1s linear .7s,
                    backdrop-filter .1s linear .7s;
      }
      /* 收合模式內圓背景：直徑 60.8px，保留外圈 9.6px 環狀間隙 */
      .wrap.collapsed::before {
        content: "";
        position: absolute;
        top: 50%; left: 50%;
        width: 60.8px; height: 60.8px;
        transform: translate(-50%, -50%);
        border-radius: 50%;
        background: var(--aitc-bg-collapse);
        pointer-events: none;
        z-index: 0;
      }
      .wrap.collapsed .circle-view { z-index: 1; }

      /* === 圓形收合模式 === */
      .circle-view {
        position: absolute; top: 0; left: 0;
        width: 80px; height: 80px;
        cursor: pointer;
        opacity: 0; pointer-events: none;
        transition: opacity .1s cubic-bezier(0.65, 0, 0.35, 1) 0s;
      }
      .wrap.collapsed .circle-view {
        opacity: 1; pointer-events: auto;
        transition: opacity .2s cubic-bezier(0.65, 0, 0.35, 1) .6s;
      }
      .ring {
        position: absolute; top: 0; left: 0;
        width: 80px; height: 80px;
        transform: rotate(-90deg);
      }
      /* 內圈：上下文使用量（r=30, W=4） */
      .ring-fill {
        fill: none; stroke: var(--aitc-ctx-color); stroke-width: 4; stroke-linecap: round;
        stroke-dasharray: ${RING_CIRCUMFERENCE};
        stroke-dashoffset: ${RING_CIRCUMFERENCE};
        transition: stroke-dashoffset 1s cubic-bezier(0.22, 1, 0.36, 1), stroke .3s;
      }
      /* 外圈：速率限制（r=38, W=4） */
      .ring-rate {
        fill: none; stroke: var(--aitc-rate-color); stroke-width: 4; stroke-linecap: round;
        stroke-dasharray: ${RATE_RING_CIRCUMFERENCE};
        stroke-dashoffset: ${RATE_RING_CIRCUMFERENCE};
        transition: stroke-dashoffset 1s cubic-bezier(0.22, 1, 0.36, 1), stroke .3s;
      }
      .logo {
        position: absolute; top: 23px; left: 23px;
        width: 34px; height: 34px;
        border-radius: 50%;
        background: var(--aitc-logo-bg);
        display: flex; align-items: center; justify-content: center;
        overflow: hidden;
        box-shadow: var(--aitc-logo-shadow);
      }
      .logo svg {
        width: 24px; height: 24px;
        display: block;
      }
      /* compact 模式 (<700px) 額外元素：百分比文字 + 模式圓點 */
      .compact-pct {
        position: absolute; bottom: 5px; left: 0; right: 0;
        text-align: center; font-size: 12px; font-weight: 600; color: #FFFFFB;
        text-shadow: 0 1px 2px rgba(11,16,19,0.7);
        opacity: 0; transition: opacity .3s;
      }
      .compact-dot {
        position: absolute; top: 6px; right: 6px;
        width: 8px; height: 8px; border-radius: 50%;
        background: var(--aitc-estimate); border: 1px solid rgba(11,16,19,0.3);
        opacity: 0; transition: opacity .3s, background .3s;
      }
      .wrap.compact .compact-pct,
      .wrap.compact .compact-dot { opacity: 1; }

      /* 收合模式展開提示：右下角 ▾（與展開模式 × 同尺寸），hover 時加深 */
      .expand-hint {
        position: absolute; bottom: 6px; right: 6px;
        width: 20px; height: 20px; font-size: 16px;
        display: inline-flex; align-items: center; justify-content: center;
        border-radius: 6px;
        color: var(--aitc-fg);
        background: transparent;
        opacity: 0; pointer-events: none;
        transition: opacity .3s, background .3s, box-shadow .3s;
      }
      .wrap.collapsed .expand-hint { opacity: 0.7; }
      .wrap.collapsed .circle-view:hover .expand-hint {
        opacity: 1;
        background: var(--aitc-bg);
        box-shadow: 0 2px 6px rgba(11,16,19,.10);
      }

      /* === 詳細模式 === */
      .head { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .title { font-weight:600; font-size:14px; opacity:0.9; display:flex; align-items:center; gap:6px; }
      .dot { width:8px; height:8px; border-radius:50%; background:var(--aitc-ctx-color); }
      .badge { font-size:12px; padding:1px 6px; border-radius:8px; background:var(--aitc-surface); }
      .badge.intercept { background: rgba(93,172,129,0.25); color:var(--aitc-intercept); }
      .badge.estimate { background: rgba(217,171,66,0.25); color:var(--aitc-estimate); }
      .toggle {
        cursor:pointer; opacity:0.7;
        display:inline-flex; align-items:center; justify-content:center;
        width:20px; height:20px; font-size:16px;
        border-radius:6px; background:var(--aitc-surface-2);
        transition: opacity .2s;
      }
      .toggle:hover { opacity:1; }

      /* body：展開後淡入(0.6s delay)、收合前淡出(0s delay)，各 0.2s */
      .body {
        overflow: hidden;
        max-height: 300px;
        opacity: 1;
        transition: opacity .2s cubic-bezier(0.65, 0, 0.35, 1) .6s,
                    max-height .3s cubic-bezier(0.65, 0, 0.35, 1) .3s;
      }
      .wrap.collapsed .body {
        max-height: 0;
        opacity: 0;
        pointer-events: none;
        transition: opacity .2s cubic-bezier(0.65, 0, 0.35, 1) 0s,
                    max-height .3s cubic-bezier(0.65, 0, 0.35, 1) .2s;
      }

      /* 速率限制區塊（顯示於上下文使用量上方） */
      .rate-section { margin-top:8px; }
      .rate-section .rl-row { display:flex; align-items:baseline; justify-content:space-between; }
      .rl-label { font-size:12px; opacity:0.7; display:flex; align-items:center; gap:4px; }
      .rl-label .rl-dot { width:6px; height:6px; border-radius:50%; background:var(--aitc-rate-color); }
      .rl-info { font-size:12px; opacity:0.85; }
      .rl-bar { height:6px; border-radius:4px; background:var(--aitc-bar-bg); margin-top:4px; overflow:hidden; }
      .rl-fill { height:100%; width:0%; border-radius:4px; transition: width 1s cubic-bezier(0.22, 1, 0.36, 1), background .3s; background:var(--aitc-rate-color); }
      .rl-detail { margin-top:3px; font-size:12px; opacity:0.6; }
      .rl-warn { color:var(--aitc-warn); }
      .rl-critical { color:var(--aitc-critical); }

      .row { display:flex; align-items:baseline; justify-content:space-between; margin-top:8px; }
      .pct { font-size:20px; font-weight:700; }
      .limit { font-size:12px; opacity:0.7; }
      .bar { height:8px; border-radius:6px; background:var(--aitc-bar-bg); margin-top:8px; overflow:hidden; }
      .fill { height:100%; width:0%; border-radius:6px; transition: width 1s cubic-bezier(0.22, 1, 0.36, 1), background .3s; background:var(--aitc-ctx-color); }
      .detail { margin-top:8px; font-size:12px; opacity:0.85; display:grid; grid-template-columns: 1fr auto; gap:2px 8px; }
      .detail .k { opacity:0.6; }

      /* loading 狀態：contextWindow 尚未取得時，進度條改為掃描動畫 */
      .bar.loading .fill {
        width: 100% !important;
        background: linear-gradient(90deg, transparent 0%, var(--aitc-shimmer) 50%, transparent 100%);
        background-size: 200% 100%;
        animation: aitc-shimmer 1.4s linear infinite;
      }
      @keyframes aitc-shimmer {
        0% { background-position: 200% 0; }
        100% { background-position: -200% 0; }
      }
      .limit.loading { opacity: 0.5; }
    `;
    shadow.appendChild(style);

    const wrap = document.createElement("div");
    wrap.className = "wrap collapsed";
    wrap.innerHTML = `
      <div class="circle-view">
        <svg class="ring" viewBox="0 0 100 100">
          <circle class="ring-rate" cx="50" cy="50" r="${RATE_RING_R}" />
          <circle class="ring-fill" cx="50" cy="50" r="${RING_R}" />
        </svg>
        <div class="logo"></div>
        <div class="compact-pct"></div>
        <div class="compact-dot"></div>
        <div class="expand-hint" title="展開">▾</div>
      </div>
      <div class="body">
        <div class="head">
          <div class="title"><span class="dot"></span><span class="label">AI Token 計數器</span></div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span class="badge"></span>
            <span class="toggle" title="收合">×</span>
          </div>
        </div>
        <div class="rate-section">
          <div class="rl-row">
            <span class="rl-label"><span class="rl-dot"></span>速率限制</span>
            <span class="rl-info">—</span>
          </div>
          <div class="rl-bar"><div class="rl-fill"></div></div>
          <div class="rl-detail">—</div>
        </div>
        <div class="row">
          <span class="pct">0%</span>
          <span class="limit" title="">0 / —</span>
        </div>
        <div class="bar"><div class="fill"></div></div>
        <div class="detail">
          <span class="k">輸入</span><span class="v-input">—</span>
          <span class="k">輸出</span><span class="v-output">—</span>
          <span class="k">剩餘</span><span class="v-remain">—</span>
        </div>
      </div>
    `;
    shadow.appendChild(wrap);

    els = {
      wrap,
      circleView: shadow.querySelector(".circle-view"),
      ringFill: shadow.querySelector(".ring-fill"),
      ringRate: shadow.querySelector(".ring-rate"),
      logo: shadow.querySelector(".logo"),
      compactPct: shadow.querySelector(".compact-pct"),
      compactDot: shadow.querySelector(".compact-dot"),
      dot: shadow.querySelector(".dot"),
      label: shadow.querySelector(".label"),
      badge: shadow.querySelector(".badge"),
      toggle: shadow.querySelector(".toggle"),
      body: shadow.querySelector(".body"),
      // 速率限制區塊
      rlInfo: shadow.querySelector(".rl-info"),
      rlFill: shadow.querySelector(".rl-fill"),
      rlDetail: shadow.querySelector(".rl-detail"),
      rlDot: shadow.querySelector(".rl-dot"),
      pct: shadow.querySelector(".pct"),
      limit: shadow.querySelector(".limit"),
      bar: shadow.querySelector(".bar"),
      fill: shadow.querySelector(".fill"),
      vInput: shadow.querySelector(".v-input"),
      vOutput: shadow.querySelector(".v-output"),
      vRemain: shadow.querySelector(".v-remain"),
    };

    // 點擊圓形 → 線性動畫展開（拖曳後 suppressClick 避免誤觸）
    els.circleView.addEventListener("click", (e) => {
      if (suppressClick) { e.stopPropagation(); return; }
      e.stopPropagation();
      els.wrap.classList.remove("collapsed");
      if (AITC.storage) AITC.storage.saveSettings({ uiCollapsed: false });
    });

    // 點擊 toggle → 收合
    els.toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      const collapsed = els.wrap.classList.toggle("collapsed");
      if (AITC.storage) AITC.storage.saveSettings({ uiCollapsed: collapsed });
    });

    // 拖曳（收合與詳細模式皆可拖曳；4px threshold 區分點擊與拖曳）
    wrap.addEventListener("mousedown", (e) => {
      if (e.target === els.toggle || els.toggle.contains(e.target)) return;
      dragState = {
        sx: e.clientX,
        sy: e.clientY,
        left: host.offsetLeft,
        top: host.offsetTop,
        started: false,
      };
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragState) return;
      const dx = e.clientX - dragState.sx;
      const dy = e.clientY - dragState.sy;
      // threshold：移動超過 4px 才啟動拖曳
      if (!dragState.started) {
        if (Math.abs(dx) < 4 && Math.abs(dy) < 4) return;
        dragState.started = true;
        // 切換為 left/top 定位以便拖曳
        if (host.style.left === "auto" || host.style.left === "") {
          host.style.left = host.offsetLeft + "px";
          host.style.top = host.offsetTop + "px";
          host.style.right = "auto";
          host.style.bottom = "auto";
        }
      }
      const nx = dragState.left + dx;
      const ny = dragState.top + dy;
      const c = clampPosition(nx, ny);
      host.style.left = c.left + "px";
      host.style.top = c.top + "px";
    });
    document.addEventListener("mouseup", () => {
      // 若拖曳已啟動，短暫抑制下一次 click（避免滑鼠放開時觸發展開）
      if (dragState && dragState.started) {
        suppressClick = true;
        setTimeout(() => { suppressClick = false; }, 50);
        // 持久化拖曳後的 left/top 位置
        if (AITC.storage) {
          AITC.storage.saveSettings({
            uiPosition: {
              left: parseInt(host.style.left, 10) || 0,
              top: parseInt(host.style.top, 10) || 0,
            },
          });
        }
      }
      dragState = null;
    });

    // 視窗尺寸變化：若為 left/top 定位則 clamp 到可視範圍；否則保持 right/bottom（自動適應）
    window.addEventListener("resize", () => {
      if (host.style.left !== "auto" && host.style.left !== "") {
        const left = parseInt(host.style.left, 10) || 0;
        const top = parseInt(host.style.top, 10) || 0;
        const c = clampPosition(left, top);
        host.style.left = c.left + "px";
        host.style.top = c.top + "px";
      }
      checkCompactMode();
    });

    document.documentElement.appendChild(host);
  }

  AITC.ui = {
    async mount() {
      if (host) return;
      buildDom();
      // 讀取記憶位置；若無則使用預設位置（右下角）
      try {
        const s = await AITC.storage.getSettings();
        if (s && s.uiPosition && s.uiPosition.left != null && s.uiPosition.top != null) {
          // 套用記憶的 left/top 位置（並 clamp 防止視窗縮小後超出可視範圍）
          const c = clampPosition(s.uiPosition.left, s.uiPosition.top);
          host.style.left = c.left + "px";
          host.style.top = c.top + "px";
          host.style.right = "auto";
          host.style.bottom = "auto";
        } else {
          applyDefaultPosition();
        }
      } catch (_) {
        applyDefaultPosition();
      }
      // 預載所有平台 SVG 圖示
      try {
        await Promise.all(Object.keys(PLATFORM_LOGOS).map(loadIcon));
      } catch (_) {}
      // compact 模式強制收合；否則讀取記憶的收合狀態
      if (window.innerWidth < COMPACT_BREAKPOINT) {
        els.wrap.classList.add("compact", "collapsed");
      } else {
        try {
          const s = await AITC.storage.getSettings();
          if (s && !s.uiCollapsed) {
            els.wrap.classList.remove("collapsed");
          }
        } catch (_) {}
      }
      // 套用主題（讀取 settings.theme，auto 時偵測頁面背景）
      try {
        const s = await AITC.storage.getSettings();
        const theme = (s && s.theme) || "auto";
        applyTheme(theme);
        // auto 模式延遲 1s 再偵測一次（SPA 初始背景可能未定）
        if (theme === "auto") setTimeout(() => applyTheme("auto"), 1000);
      } catch (_) {
        applyTheme("auto");
      }
    },

    unmount() {
      if (host && host.parentNode) host.parentNode.removeChild(host);
      host = null;
      shadow = null;
      els = {};
    },

    /** state: { platform, contextWindow, used, inputTokens, outputTokens, source, showSourceBadge,
     *          rateLimit, rateLimitUsage, rateLimitPredict } */
    update(state) {
      if (!host) return;
      lastState = state;
      const used = state.used || 0;
      const limit = state.contextWindow || 0;
      const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
      const isIntercept = state.source === "intercept";
      const modeColor = isIntercept ? MODE_COLORS.intercept : MODE_COLORS.estimate;
      const levelColor = ctxColor(pct);
      const isCompact = els.wrap.classList.contains("compact");
      const logo = state.platform ? getLogo(state.platform.id) : getLogo(null);

      // logo（inline SVG 圖示；尚未載入時用字母 fallback）
      const svg = iconCache[state.platform ? state.platform.id : ""];
      if (svg) {
        els.logo.innerHTML = svg;
        els.logo.style.background = "";
      } else {
        els.logo.style.background = "";
        els.logo.textContent = logo.color.charAt(1).toUpperCase();
      }

      // loading 狀態：contextWindow 尚未取得（limit<=0）或尚未取得任何使用量資料
      const isLoading = limit <= 0 || (state.source == null && (used === 0 || used == null));
      if (isLoading) {
        els.bar.classList.add("loading");
        els.limit.classList.add("loading");
        els.ringFill.style.strokeDashoffset = RING_CIRCUMFERENCE;
        if (els.ringRate) els.ringRate.style.strokeDashoffset = RATE_RING_CIRCUMFERENCE;
        els.compactPct.textContent = "—";
        els.label.textContent = state.platform
          ? state.platform.label
          : "AI Token 計數器";
        els.dot.style.background = "#91989F";
        els.pct.textContent = "—";
        els.limit.textContent = "載入中…";
        els.limit.title = "正在取得 contextWindow";
        els.fill.style.width = "0%";
        els.vInput.textContent = "—";
        els.vOutput.textContent = "—";
        els.vRemain.textContent = "—";
        els.badge.style.display = "none";
        // 速率限制區塊重置
        if (els.rlInfo) els.rlInfo.textContent = "—";
        if (els.rlFill) els.rlFill.style.width = "0%";
        if (els.rlDetail) els.rlDetail.textContent = "—";
        return;
      }

      // 一般狀態：移除 loading 標記
      els.bar.classList.remove("loading");
      els.limit.classList.remove("loading");

      // 內圈圓形進度條（上下文使用量）— 收合/展開統一用 levelColor
      const offset = RING_CIRCUMFERENCE * (1 - pct / 100);
      els.ringFill.style.strokeDashoffset = offset;
      els.ringFill.style.stroke = levelColor;
      if (isCompact) {
        els.compactDot.style.background = modeColor;
      }
      els.compactPct.textContent = pct.toFixed(pct < 10 ? 1 : 0) + "%";

      // 外圈圓形進度條（速率限制）— 收合/展開統一用 rateColor
      if (els.ringRate && state.rateLimit && state.rateLimit.messageLimit > 0 && state.rateLimitUsage) {
        const rlCount = state.rateLimitUsage.count || 0;
        const rlLimit = state.rateLimit.messageLimit;
        const rlPct = Math.min(100, (rlCount / rlLimit) * 100);
        const rlOffset = RATE_RING_CIRCUMFERENCE * (1 - rlPct / 100);
        els.ringRate.style.strokeDashoffset = rlOffset;
        els.ringRate.style.stroke = rateColor(rlPct);
      } else if (els.ringRate) {
        // 無速率限制（如付費版）→ 外圈隱藏
        els.ringRate.style.strokeDashoffset = RATE_RING_CIRCUMFERENCE;
      }

      // 詳細模式
      els.label.textContent = state.platform
        ? state.platform.label
        : "AI Token 計數器";
      els.dot.style.background = levelColor;
      els.pct.textContent = pct.toFixed(pct < 10 ? 1 : 0) + "%";
      els.limit.textContent = `${fmt(used)} / ${fmt(limit)}`;
      // contextWindow 來源 tooltip：標示為預設值
      els.limit.title = `上限：${fmt(limit)} tokens（預設值）`;
      els.fill.style.width = pct + "%";
      els.fill.style.background = levelColor;

      els.vInput.textContent = fmt(state.inputTokens);
      els.vOutput.textContent = fmt(state.outputTokens);
      els.vRemain.textContent = fmt(limit - used);

      if (state.showSourceBadge && state.source) {
        els.badge.style.display = "";
        els.badge.className = "badge " + state.source;
        els.badge.textContent = state.source === "intercept" ? "精準" : "估算";
      } else {
        els.badge.style.display = "none";
      }

      // 速率限制區塊（展開模式，顯示於上下文使用量上方）
      updateRateSection(state);
    },
  };

  /** 更新展開模式的速率限制區塊 */
  function updateRateSection(state) {
    if (!els.rlInfo || !els.rlFill || !els.rlDetail) return;
    const rl = state.rateLimit;
    const usage = state.rateLimitUsage;
    const predict = state.rateLimitPredict;
    if (!rl || rl.messageLimit <= 0 || !usage) {
      // 無速率限制（付費版無限制）
      els.rlInfo.textContent = "無限制";
      els.rlFill.style.width = "0%";
      els.rlDetail.textContent = "—";
      els.rlDetail.className = "rl-detail";
      if (els.rlDot) els.rlDot.style.background = "var(--aitc-rate-color)";
      return;
    }
    const count = usage.count || 0;
    const rlLimit = rl.messageLimit;
    const rlPct = Math.min(100, (count / rlLimit) * 100);
    const rlColor = rateColor(rlPct);

    els.rlInfo.textContent =
      count + " / " + rlLimit + " 則 (" +
      AITC.rateLimit.formatWindow(rl.windowMs) + ")";
    els.rlFill.style.width = rlPct + "%";
    els.rlFill.style.background = rlColor;
    if (els.rlDot) els.rlDot.style.background = rlColor;

    // 詳細資訊：預估剩餘 + 重置時間
    let detailParts = [];
    if (predict && predict.remainingMsgs > 0) {
      detailParts.push("還可送 " + predict.remainingMsgs + " 則");
    }
    if (predict && predict.etaMin != null && predict.etaMin > 0 && rlPct >= 50) {
      const etaStr =
        predict.etaMin < 60
          ? Math.ceil(predict.etaMin) + " 分鐘"
          : (predict.etaMin / 60).toFixed(1) + " 小時";
      detailParts.push("預估 " + etaStr + " 後觸發");
    }
    if (usage.resetInMs > 0) {
      detailParts.push("重置 " + AITC.rateLimit.formatReset(usage.resetInMs));
    }
    els.rlDetail.textContent = detailParts.length > 0 ? detailParts.join(" · ") : "—";
    // 警告等級樣式
    els.rlDetail.className = "rl-detail";
    if (rlPct >= 90) els.rlDetail.classList.add("rl-critical");
    else if (rlPct >= 70) els.rlDetail.classList.add("rl-warn");
  }
})();
