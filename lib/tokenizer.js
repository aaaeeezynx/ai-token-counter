// lib/tokenizer.js
// WASM tokenizer 包裝。優先嘗試載入 lib/tiktoken.wasm；失敗則回退到啟發式估算。
// 註：真實 tiktoken.wasm 需使用者自行放入 lib/（或以 @dqbd/tiktoken 建置產出）；
//     未提供時自動使用 CJK 感知的字元啟發式估算（誤差較大，僅作回退用途）。
(function () {
  "use strict";

  const AITC = (globalThis.AITC = globalThis.AITC || {});

  let wasmTokenizer = null; // { encode(text): number[] } 若 WASM 載入成功
  let initPromise = null;
  let initFailed = false;

  function tryLoadWasm() {
    if (initPromise) return initPromise;
    initPromise = (async () => {
      try {
        if (
          typeof chrome === "undefined" ||
          !chrome.runtime ||
          !chrome.runtime.getURL
        )
          return null;
        const url = chrome.runtime.getURL("lib/tiktoken.wasm");
        const res = await fetch(url);
        if (!res.ok) return null;
        const bytes = await res.arrayBuffer();
        const mod = await WebAssembly.instantiate(bytes);
        const inst = mod.instance || mod;
        // 預期 tiktoken WASM 介面各異；這裡僅做防禦性偵測。
        // 若 WASM 暴露 encode 函式則使用之，否則回 null 走啟發式。
        const exp = inst.exports || {};
        if (typeof exp.encode === "function") {
          wasmTokenizer = {
            encode(text) {
              try {
                return exp.encode(text);
              } catch (_) {
                return null;
              }
            },
          };
          return wasmTokenizer;
        }
        return null;
      } catch (_) {
        initFailed = true;
        return null;
      }
    })();
    return initPromise;
  }

  // CJK 範圍檢測（中日韓）：用於啟發式估算時區分字元密度。
  function isCJK(code) {
    return (
      (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified
      (code >= 0x3400 && code <= 0x4dbf) || // CJK Ext A
      (code >= 0xf900 && code <= 0xfaff) || // CJK Compat
      (code >= 0x3040 && code <= 0x30ff) || // 日文假名
      (code >= 0xac00 && code <= 0xd7af) // 韓文音節
    );
  }

  // 啟發式估算：CJK 字元 ≈ 0.75 token，其餘 ≈ 1 token / 4 字元。
  function heuristicCount(text) {
    if (!text) return 0;
    let cjk = 0;
    let other = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (isCJK(code)) cjk++;
      else other++;
    }
    return Math.ceil(cjk * 0.75 + other / 4);
  }

  AITC.tokenizer = {
    /** 非同步初始化（嘗試載入 WASM）。可不呼叫，countTokens 會自動 lazy init。 */
    async init() {
      await tryLoadWasm();
      return !!wasmTokenizer;
    },

    /** 估算 token 數。回傳 { count, source } source 為 'wasm' 或 'heuristic' */
    async countTokens(text, modelFamily) {
      if (!text) return { count: 0, source: "heuristic" };
      if (!wasmTokenizer && !initFailed) await tryLoadWasm();
      if (wasmTokenizer) {
        const arr = wasmTokenizer.encode(text);
        if (Array.isArray(arr)) return { count: arr.length, source: "wasm" };
      }
      return { count: heuristicCount(text), source: "heuristic" };
    },

    /** 同步估算（永遠走啟發式，供不能 await 的場景） */
    estimateSync(text) {
      return heuristicCount(text);
    },

    isWasmLoaded() {
      return !!wasmTokenizer;
    },
  };
})();
