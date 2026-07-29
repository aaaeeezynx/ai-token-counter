// content/inject.js
// 執行於 MAIN 世界（world:MAIN, document_start），繞過頁面 CSP。
// 職責：hook window.fetch 與 XMLHttpRequest，攔截 SSE 串流，逐行掃描所有 data: 行，
//       統一擷取 usage，透過 window.postMessage 推送給 ISOLATED 內容腳本。
// 注意：MAIN 世界無法存取 chrome.* API 與 AITC 命名空間，平台設定需內嵌。
(function () {
  "use strict";

  if (window.__AITC_INJECT_INSTALLED__) return;
  window.__AITC_INJECT_INSTALLED__ = true;
  window.__AITC_LOG = []; // 診斷日誌：記錄所有攔截嘗試
  function log(entry) {
    try {
      window.__AITC_LOG.push(Object.assign({ ts: Date.now() }, entry));
      if (window.__AITC_LOG.length > 200) window.__AITC_LOG.shift();
    } catch (_) {}
  }

  // ---- 平台設定（與 lib/platforms.js 同步的精簡版，供 MAIN 世界使用）----
  const PLATFORMS = {
    claude: {
      hostMatches: ["claude.ai"],
      conversationUrlPattern: /\/chat\/([a-f0-9-]+)/i,
      streamUrlPattern:
        /\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/completion/i,
      // GET 對話歷史：/api/organizations/{org}/chat_conversations/{id}?tree=True
      // 注意：ID 後直接接 ?query 或字尾，不可匹配 /completion（串流端點）
      historyUrlPattern:
        /\/api\/organizations\/[^/]+\/chat_conversations\/[a-f0-9-]+(?:\?|$)/i,
      noiseUrlPatterns: [
        /\/api\/organizations\/[^/]+\/(?!chat_conversations)/i,
        /\/api\/bootstrap/,
        /\/api\/settings/,
      ],
      // Claude SSE：message_start 帶 message.usage.input_tokens，
      // message_delta 帶 usage.output_tokens（累計）。需合併跨 chunk。
      usagePaths: [
        "usage.input_tokens",
        "usage.output_tokens",
        "message.usage.input_tokens",
        "message.usage.output_tokens",
      ],
    },
    chatgpt: {
      hostMatches: ["chatgpt.com", "chat.openai.com"],
      conversationUrlPattern: /\/c\/([a-f0-9-]+)/i,
      // 實機驗證：免費版 backend-anon/f/conversation，付費版 backend-api/conversation
      streamUrlPattern: /\/backend-(api|anon)\/(f\/)?conversation$/i,
      // GET 對話歷史：/backend-api/conversation/{id}（不含 /init, /stream_status 等）
      historyUrlPattern: /\/backend-api\/conversation\/[a-f0-9-]+$/i,
      noiseUrlPatterns: [
        /\/backend-(api|anon)\/accounts/i,
        /\/backend-(api|anon)\/settings/i,
        /\/backend-(api|anon)\/system_hints/i,
        /\/backend-(api|anon)\/sentinel/i,
        /\/backend-(api|anon)\/calpico/i,
        /\/backend-(api|anon)\/me/,
        /\/backend-(api|anon)\/models/,
        /\/backend-(api|anon)\/.*?conversation\/prepare/i,
      ],
      usagePaths: [
        "message.usage.input_tokens",
        "message.usage.output_tokens",
        "usage.prompt_tokens",
        "usage.completion_tokens",
      ],
    },
    gemini: {
      hostMatches: ["gemini.google.com"],
      conversationUrlPattern: /\/app\/([a-f0-9]+)/i,
      // 實機驗證：串流端點為 StreamGenerate（XHR POST）
      streamUrlPattern: /\/StreamGenerate\b/i,
      // GET 對話歷史：batchexecute RPC hNvQHb（載入對話時觸發）
      historyUrlPattern: /\/BardChatUi\/data\/batchexecute.*?rpcids=hNvQHb/i,
      noiseUrlPatterns: [
        /\/batchexecute/i,
        /\/google-analytics\.com/i,
        /\/googleadservices\.com/i,
        /\/pagead\//i,
        /\/measurement\/conversion/i,
      ],
      usagePaths: [
        "usageMetadata.promptTokenCount",
        "usageMetadata.candidatesTokenCount",
        "usageMetadata.totalTokenCount",
      ],
    },
    deepseek: {
      hostMatches: ["chat.deepseek.com"],
      conversationUrlPattern: /\/a\/chat\/s\/([a-f0-9-]+)/i,
      // SSE 串流端點
      streamUrlPattern: /\/api\/v0\/chat\/completion/i,
      // GET 對話歷史：/api/v0/chat/history_messages?chat_session_id={id}
      historyUrlPattern: /\/api\/v0\/chat\/history_messages/i,
      noiseUrlPatterns: [
        /\/api\/v0\/client\/settings/i,
        /\/api\/v0\/users\//i,
        /\/api\/v0\/chat_session\/fetch_page/i,
        /\/api\/v0\/chat\/create_pow_challenge/i,
      ],
      // SSE usage：accumulated_token_usage（總 token 數）
      // 注意：DeepSeek 使用 JSON Patch 格式 {p,o,v} 更新 usage，需特殊處理
      usagePaths: [
        "v.response.accumulated_token_usage",
      ],
    },
    grok: {
      hostMatches: ["grok.com"],
      conversationUrlPattern: /\/c\/([a-f0-9-]+)/i,
      // 串流端點（兩種）：
      //   新對話：POST /rest/app-chat/conversations/new
      //   後續訊息：POST /rest/app-chat/conversations/{id}/responses
      streamUrlPattern:
        /\/rest\/app-chat\/conversations\/(?:new|[a-f0-9-]+\/responses)(?:\?|$)/i,
      // POST 對話歷史：/rest/app-chat/conversations/{id}/load-responses
      // body: {"responseIds":[...]}，回應含完整訊息
      historyUrlPattern:
        /\/rest\/app-chat\/conversations\/[a-f0-9-]+\/load-responses(?:\?|$)/i,
      noiseUrlPatterns: [
        /\/rest\/app-chat\/conversations\?/i,
        /\/rest\/app-chat\/conversations_v2\//i,
        /\/rest\/conversations\/files\/list/i,
        /\/rest\/workspaces/i,
        /\/rest\/modes/i,
        /\/rest\/skills/i,
        /\/rest\/rate-limits/i,
        /\/rest\/system-prompt\//i,
        /\/rest\/suggestions\//i,
        /\/rest\/products/i,
        /\/rest\/user-settings/i,
        /\/rest\/user-skills/i,
        /\/rest\/assets/i,
        /\/rest\/tasks/i,
        /\/rest\/notifications\//i,
        /\/api\/auth\//i,
        /\/grok_api_v2\./i,
        /\/prod\.grok\./i,
        /\/_worker\/typeahead/i,
        /\/_data\/v1\//i,
        /\/monitoring/i,
        /\/cdn-cgi\//i,
        /\/api\/log_metric/i,
      ],
      // Grok 不在串流中提供 usage 欄位（已實機驗證）
      // 使用 request body + DOM history + WASM tokenizer 計算
      usagePaths: [],
    },
    perplexity: {
      hostMatches: ["www.perplexity.ai", "perplexity.ai"],
      // 對話 URL：/search/{thread_uuid}
      conversationUrlPattern: /\/search\/([a-f0-9-]+)/i,
      // 串流端點：POST /rest/sse/perplexity_ask（SSE）
      // request body: { params: {...}, query_str: "使用者輸入" }
      streamUrlPattern: /\/rest\/sse\/perplexity_ask(?:\?|$)/i,
      // GET 對話歷史：/rest/thread/{uuid}?with_parent_info=true...
      // 回應結構：{ entries: [{ query_str, display_model, blocks: [{ markdown_block: { answer } }] }] }
      historyUrlPattern: /\/rest\/thread\/[a-f0-9-]+(?:\?|$)/i,
      noiseUrlPatterns: [
        /\/rest\/thread\/list_/i,
        /\/rest\/thread\/list_pinned/i,
        /\/rest\/thread\/mark_viewed/i,
        /\/rest\/sse\/recent_thread_updates/i,
        /\/rest\/event\/analytics/i,
        /\/rest\/user\//i,
        /\/rest\/billing\//i,
        /\/rest\/collections\//i,
        /\/rest\/sidebar\//i,
        /\/rest\/sources/i,
        /\/rest\/tasks\//i,
        /\/rest\/models\/config/i,
        /\/rest\/rate-limit\//i,
        /\/rest\/experiments\//i,
        /\/rest\/notifications\//i,
        /\/rest\/academic\//i,
        /\/rest\/enterprise\//i,
        /\/rest\/visitor\//i,
        /\/rest\/pipedream\//i,
        /\/rest\/assets\//i,
        /\/rest\/ping/i,
        /\/rest\/homepage-widgets\//i,
        /\/api\/auth\//i,
        /\/api\/log/i,
        /suggest\.perplexity\.ai/i,
        /\/cdn-cgi\//i,
        /sdk-api-v1\.singular\.net/i,
        /browser-intake-datadoghq\.com/i,
        /fscdn\.eppo\.cloud/i,
        /dubcdn\.com/i,
        /count\.perplexity\.ai/i,
        /edge\.perplexity\.ai\/image/i,
      ],
      // Perplexity 不在串流中提供 usage 欄位
      // 使用 request body query_str + history JSON + WASM tokenizer 計算
      usagePaths: [],
    },
    qwen: {
      hostMatches: ["chat.qwen.ai"],
      // 對話 URL：/c/{chat_id}
      conversationUrlPattern: /\/c\/([a-f0-9-]+)/i,
      // 串流端點：POST /api/v2/chat/completions?chat_id={id}（SSE）
      streamUrlPattern: /\/api\/v2\/chat\/completions(?:\?|$)/i,
      // GET 對話歷史：/api/v2/chats/{id}（不含 /new、列表查詢）
      historyUrlPattern: /\/api\/v2\/chats\/[a-f0-9-]+$/i,
      noiseUrlPatterns: [
        /\/api\/v2\/chats\/new/i,
        /\/api\/v2\/chats\/\?/i,
        /\/api\/v2\/users\//i,
        /\/api\/v2\/configs\//i,
        /\/api\/v2\/notifications\//i,
        /\/api\/v2\/library\//i,
        /\/aplus\.qwen\.ai/i,
        /\/fourier\.(alibaba|taobao)\.com/i,
        /\/pagead2\.googlesyndication/i,
        /\/google\.com\/pagead/i,
        /\/googletagmanager/i,
        /\/google-analytics/i,
      ],
      // Qwen SSE 提供 usage：input_tokens、output_tokens、total_tokens
      usagePaths: [
        "usage.input_tokens",
        "usage.output_tokens",
        "usage.total_tokens",
      ],
    },
  };

  function detectPlatform(host) {
    for (const key in PLATFORMS) {
      const p = PLATFORMS[key];
      if (p.hostMatches.some((h) => host === h || host.endsWith("." + h))) return p;
    }
    return null;
  }

  function getByPath(obj, path) {
    return path.split(".").reduce((acc, k) => {
      if (acc && typeof acc === "object" && k in acc) return acc[k];
      return undefined;
    }, obj);
  }

  function extractUsage(platform, parsed) {
    if (!parsed || typeof parsed !== "object") return null;
    let inputTokens = null;
    let outputTokens = null;
    let totalTokens = null;
    for (const path of platform.usagePaths) {
      const v = getByPath(parsed, path);
      if (v == null) continue;
      if (/input|prompt/i.test(path)) inputTokens = v;
      else if (/output|candidates|completion/i.test(path)) outputTokens = v;
      else if (/total|accumulated/i.test(path)) totalTokens = v;
    }
    // DeepSeek JSON Patch 格式：{p:"response", o:"BATCH", v:[{p:"accumulated_token_usage", v:69}, ...]}
    // accumulated_token_usage 是總 token 數（含 input + output）
    if (totalTokens == null && parsed.o === "BATCH" && Array.isArray(parsed.v)) {
      for (const patch of parsed.v) {
        if (patch && patch.p === "accumulated_token_usage" && typeof patch.v === "number") {
          totalTokens = patch.v;
          break;
        }
      }
    }
    if (totalTokens == null) {
      const tp = platform.usagePaths.find((p) => /total/i.test(p));
      if (tp) totalTokens = getByPath(parsed, tp);
    }
    if (inputTokens == null && outputTokens == null && totalTokens == null)
      return null;
    if (totalTokens == null && inputTokens != null && outputTokens != null)
      totalTokens = inputTokens + outputTokens;
    if (inputTokens == null && totalTokens != null && outputTokens != null)
      inputTokens = totalTokens - outputTokens;
    if (outputTokens == null && totalTokens != null && inputTokens != null)
      outputTokens = totalTokens - inputTokens;
    return { inputTokens, outputTokens, totalTokens };
  }

  function getConversationId(platform, url) {
    if (!platform) return null;
    const m = (url || location.href).match(platform.conversationUrlPattern);
    return m ? m[1] : null;
  }

  function postUsage(platform, url, usage, conversationId) {
    try {
      window.postMessage(
        {
          source: "aitc-inject",
          type: "usage",
          platform: platform.hostMatches[0],
          platformId: detectPlatformKey(platform),
          url,
          conversationId: conversationId || getConversationId(platform, url),
          usage,
          ts: Date.now(),
        },
        location.origin
      );
    } catch (_) {}
  }

  /** 將請求 body 文字傳給 ISOLATED 進行精確 token 計數。
   *  這是真實 API 收到的 prompt 內容（含系統提示、工具定義、完整對話歷史），
   *  比 DOM 抓取更準確（DOM 抓取會遺漏系統提示與工具定義）。 */
  function postRequestBody(platform, url, bodyText, conversationId) {
    try {
      window.postMessage(
        {
          source: "aitc-inject",
          type: "request-body",
          platform: platform.hostMatches[0],
          platformId: detectPlatformKey(platform),
          url,
          conversationId: conversationId || getConversationId(platform, url),
          bodyText,
          ts: Date.now(),
        },
        location.origin
      );
    } catch (_) {}
  }

  /** 將對話歷史 body 文字傳給 ISOLATED 進行 token 計數。
   *  當頁面載入或切換對話時，GET request 的回應包含完整對話歷史。
   *  ISOLATED 會從中擷取對話文字並用 tokenizer 計算 input_tokens。 */
  function postHistoryBody(platform, url, bodyText, conversationId) {
    try {
      window.postMessage(
        {
          source: "aitc-inject",
          type: "history-body",
          platform: platform.hostMatches[0],
          platformId: detectPlatformKey(platform),
          url,
          conversationId: conversationId || getConversationId(platform, url),
          bodyText,
          ts: Date.now(),
        },
        location.origin
      );
    } catch (_) {}
  }

  /** 從各平台 request body 中擷取實際發送給 API 的文字內容。
   *  Claude web 的 prompt 只含最新訊息（非完整歷史），但 tools 含大量工具定義。
   *  ISOLATED 端會將此處擷取的文字與 DOM 抓取的對話歷史合併計算。 */
  function extractRequestText(platformKey, body) {
    if (!body || typeof body !== "string") return "";
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      // 非 JSON，回傳原始字串
      return body;
    }

    const parts = [];

    if (platformKey === "claude") {
      // Claude web: { prompt: "最新訊息字串", tools: [...], ... }
      // 注意：prompt 只是最新訊息，對話歷史由伺服器以 parent_message_uuid 追蹤
      if (typeof parsed.prompt === "string") {
        parts.push(parsed.prompt);
      } else if (Array.isArray(parsed.prompt)) {
        // 部分 API 變體可能使用陣列
        parsed.prompt.forEach((msg) => {
          if (!msg) return;
          if (typeof msg.content === "string") {
            parts.push(msg.content);
          } else if (Array.isArray(msg.content)) {
            msg.content.forEach((c) => {
              if (c && typeof c.text === "string") parts.push(c.text);
            });
          }
        });
      }
      if (typeof parsed.system === "string") {
        parts.push(parsed.system);
      }
      if (Array.isArray(parsed.tools)) {
        // 工具定義（Claude 有 26 個工具，含 artifacts、web search 等）
        // 這是 API 計算 input_tokens 的重要部分
        parsed.tools.forEach((t) => {
          if (t && typeof t === "object") {
            if (typeof t.description === "string") parts.push(t.description);
            if (t.input_schema) parts.push(JSON.stringify(t.input_schema));
          }
        });
      }
    } else if (platformKey === "chatgpt") {
      // ChatGPT: { messages: [...], ... }
      // 注意：messages 只含最新訊息，歷史由 parent_message_id 追蹤
      if (Array.isArray(parsed.messages)) {
        parsed.messages.forEach((m) => {
          if (!m) return;
          // ChatGPT content 結構: { content_type: "text", parts: ["..."] }
          if (typeof m.content === "string") {
            parts.push(m.content);
          } else if (Array.isArray(m.content)) {
            m.content.forEach((c) => {
              if (c && typeof c.text === "string") parts.push(c.text);
              else if (typeof c === "string") parts.push(c);
            });
          } else if (m.content && typeof m.content === "object") {
            if (typeof m.content.text === "string") parts.push(m.content.text);
            if (Array.isArray(m.content.parts)) {
              m.content.parts.forEach((p) => {
                if (typeof p === "string") parts.push(p);
              });
            }
          }
        });
      }
    } else if (platformKey === "gemini") {
      // Gemini 結構多變，盡可能擷取
      if (parsed.prompt) {
        parts.push(JSON.stringify(parsed.prompt));
      }
      if (Array.isArray(parsed.messages)) {
        parsed.messages.forEach((m) => {
          if (typeof m === "string") parts.push(m);
          else if (m && m.content) parts.push(JSON.stringify(m.content));
        });
      }
    } else if (platformKey === "deepseek") {
      // DeepSeek: { prompt: "最新訊息", chat_session_id, ... }
      // 注意：prompt 只是最新訊息，對話歷史由伺服器以 parent_message_id 追蹤
      if (typeof parsed.prompt === "string") {
        parts.push(parsed.prompt);
      }
    } else if (platformKey === "grok") {
      // Grok: { message: "使用者輸入的文字", ... }
      // 新對話 body 含 temporary/fileAttachments 等，後續訊息含 parentResponseId
      // message 是使用者最新輸入的純文字，對話歷史由伺服器以 parentResponseId 追蹤
      if (typeof parsed.message === "string") {
        parts.push(parsed.message);
      }
    } else if (platformKey === "perplexity") {
      // Perplexity: { params: {...}, query_str: "使用者輸入" }
      // params 含 last_backend_uuid（後續訊息）、model_preference、sources 等
      // query_str 是使用者最新輸入的純文字
      if (typeof parsed.query_str === "string") {
        parts.push(parsed.query_str);
      }
    } else if (platformKey === "qwen") {
      // Qwen: { messages: [{ role, content, ... }], model, ... }
      // messages 只含最新訊息，對話歷史由伺服器以 parent_id 追蹤
      if (Array.isArray(parsed.messages)) {
        parsed.messages.forEach((m) => {
          if (!m) return;
          if (typeof m.content === "string") {
            parts.push(m.content);
          } else if (Array.isArray(m.content)) {
            m.content.forEach((c) => {
              if (typeof c === "string") parts.push(c);
              else if (c && typeof c.text === "string") parts.push(c.text);
            });
          }
        });
      }
    }

    // 若擷取失敗，回傳原始 body
    if (parts.length === 0) return body;
    return parts.join("\n\n");
  }

  /** SSE 完成但無 usage 時（如 Claude web 不帶 usage），通知 ISOLATED 立即估算。 */
  function postResponseComplete(platform, url, conversationId) {
    try {
      window.postMessage(
        {
          source: "aitc-inject",
          type: "response-complete",
          platform: platform.hostMatches[0],
          platformId: detectPlatformKey(platform),
          url,
          conversationId: conversationId || getConversationId(platform, url),
          ts: Date.now(),
        },
        location.origin
      );
    } catch (_) {}
  }

  function detectPlatformKey(platform) {
    for (const k in PLATFORMS) if (PLATFORMS[k] === platform) return k;
    return null;
  }

  /** 由 SSE / JSON 文字中擷取 usage。逐行掃描所有 data: 行，合併跨 chunk usage
   *  （Claude message_start 帶 input_tokens、message_delta 帶 output_tokens）。 */
  function parseBodyForUsage(platform, text) {
    if (!text) return null;
    let merged = null;

    // SSE：逐行處理 data: 行
    const lines = text.split(/\r?\n/);
    let hasDataLine = false;
    for (const line of lines) {
      const m = line.match(/^\s*data:\s*(.*)$/);
      if (!m) continue;
      hasDataLine = true;
      const payload = m[1].trim();
      if (!payload || payload === "[DONE]") continue;
      try {
        const obj = JSON.parse(payload);
        const u = extractUsage(platform, obj);
        if (u) {
          if (!merged) merged = { inputTokens: null, outputTokens: null, totalTokens: null };
          // 合併：每個欄位取最後一個非 null 值（Claude output_tokens 為累計值）
          if (u.inputTokens != null) merged.inputTokens = u.inputTokens;
          if (u.outputTokens != null) merged.outputTokens = u.outputTokens;
          if (u.totalTokens != null) merged.totalTokens = u.totalTokens;
        }
      } catch (_) {
        /* 非 JSON，略過 */
      }
    }

    // 非 SSE：嘗試整段 JSON
    if (!hasDataLine) {
      try {
        const obj = JSON.parse(text);
        const u = extractUsage(platform, obj);
        if (u) merged = u;
      } catch (_) {
        /* 不是 JSON，略過 */
      }
    }

    // 最終計算缺失欄位。output_tokens 為累計值，跨 chunk 後需重算 total。
    if (merged) {
      if (merged.inputTokens != null && merged.outputTokens != null)
        merged.totalTokens = merged.inputTokens + merged.outputTokens;
      else if (merged.totalTokens == null && merged.inputTokens != null && merged.outputTokens != null)
        merged.totalTokens = merged.inputTokens + merged.outputTokens;
      if (merged.inputTokens == null && merged.totalTokens != null && merged.outputTokens != null)
        merged.inputTokens = merged.totalTokens - merged.outputTokens;
      if (merged.outputTokens == null && merged.totalTokens != null && merged.inputTokens != null)
        merged.outputTokens = merged.totalTokens - merged.inputTokens;
    }

    return merged;
  }

  const platform = detectPlatform(location.host);

  // 非支援平台則不安裝 hook
  if (!platform) return;

  // ---- Claude SSR 場景：頁面重新整理時無 history fetch 可攔截 ----
  // Claude 使用 SSR，對話資料嵌入 HTML，重新整理時不會發出 history GET request。
  // 解法：從其他 API 請求擷取 org ID，延遲後若無 history 攔截則主動發起 history fetch。
  let capturedOrgId = null;
  let historyInterceptedForConvId = null;
  let capturedDeepSeekHeaders = null;

  /** 從 URL 中擷取 Claude org ID */
  function extractClaudeOrgId(url) {
    const m = url.match(/\/api\/organizations\/([a-f0-9-]+)\//i);
    return m ? m[1] : null;
  }

  /** 主動發起 Claude history fetch（SSR 場景的 fallback） */
  function fetchClaudeHistory(orgId, convId) {
    const url = "/api/organizations/" + orgId + "/chat_conversations/" + convId + "?tree=True&rendering_mode=messages&render_all_tools=true&consistency=strong";
    log({ kind: "history-proactive-fetch", url: url.slice(0, 120), convId: convId });
    origFetch(url, { method: "GET", credentials: "include" })
      .then((res) => {
        try {
          const cloned = res.clone();
          cloned.text().then((text) => {
            log({ kind: "history-proactive-loaded", url: url.slice(0, 80), len: text.length });
            window.__AITC_LAST_HISTORY_BODY = text;
            postHistoryBody(platform, url, text, convId);
          }).catch((e) => {
            log({ kind: "history-proactive-err", err: String(e).slice(0, 200) });
          });
        } catch (e) {
          log({ kind: "history-proactive-err", err: String(e).slice(0, 200) });
        }
      })
      .catch((e) => {
        log({ kind: "history-proactive-fetch-err", err: String(e).slice(0, 200) });
      });
  }

  /** DeepSeek cache_control:MERGE 場景的主動 history fetch。
   *  當 history API 回傳 MERGE + 空 chat_messages 時，客戶端使用本地快取。
   *  移除 cache_version 和 cache_reset_at 參數，強制伺服器回傳完整對話歷史。
   *  需重播原始 XHR 的認證標頭，否則伺服器回傳 INVALID_TOKEN。 */
  function fetchDeepSeekHistoryFull(originalUrl, authHeaders) {
    try {
      const url = new URL(originalUrl, location.origin);
      // 從 chat_session_id 查詢參數擷取對話 ID（API URL 不含 /a/chat/s/ 路徑）
      const sessionId = url.searchParams.get("chat_session_id");
      // 移除 cache 參數，強制伺服器回傳完整資料（非 MERGE）
      url.searchParams.delete("cache_version");
      url.searchParams.delete("cache_reset_at");
      const cleanUrl = url.toString();
      log({ kind: "history-proactive-fetch", url: cleanUrl.slice(0, 120), convId: sessionId, hasAuthHeaders: !!authHeaders });
      // 標記此對話已有 history 攔截，避免重複主動 fetch
      if (sessionId) historyInterceptedForConvId = sessionId;
      origFetch(cleanUrl, { method: "GET", credentials: "include", headers: authHeaders || {} })
        .then((res) => {
          try {
            const cloned = res.clone();
            cloned.text().then((text) => {
              log({
                kind: "history-proactive-loaded",
                url: cleanUrl.slice(0, 80),
                len: text.length,
                hasMerge: text.indexOf("MERGE") >= 0,
              });
              window.__AITC_LAST_HISTORY_BODY = text;
              postHistoryBody(platform, cleanUrl, text, sessionId);
            }).catch((e) => {
              log({ kind: "history-proactive-err", err: String(e).slice(0, 200) });
            });
          } catch (e) {
            log({ kind: "history-proactive-err", err: String(e).slice(0, 200) });
          }
        })
        .catch((e) => {
          log({ kind: "history-proactive-fetch-err", err: String(e).slice(0, 200) });
        });
    } catch (e) {
      log({ kind: "history-proactive-url-err", err: String(e).slice(0, 200) });
    }
  }

  // 延遲檢查：若 4 秒後仍無 history 攔截，主動發起
  setTimeout(() => {
    if (detectPlatformKey(platform) !== "claude") return;
    const convId = getConversationId(platform, location.href);
    if (!convId) return;
    // 若已有 history 攔截（SPA 場景），不需主動 fetch
    if (historyInterceptedForConvId === convId) {
      log({ kind: "history-proactive-skip", reason: "already-intercepted", convId: convId });
      return;
    }
    if (!capturedOrgId) {
      log({ kind: "history-proactive-skip", reason: "no-org-id", convId: convId });
      return;
    }
    fetchClaudeHistory(capturedOrgId, convId);
  }, 4000);

  // ---- DeepSeek SPA 場景：切換到已快取對話時不發 history 請求 ----
  // DeepSeek 客戶端使用本地快取，切換到已訪問過的對話時不發 history API 請求。
  // 解法：監測 URL 變化，若 4 秒後仍無 history 攔截，主動 fetch history。
  if (detectPlatformKey(platform) === "deepseek") {
    let lastDsUrl = location.href;
    let dsProactiveTimer = null;
    setInterval(() => {
      const currentUrl = location.href;
      if (currentUrl === lastDsUrl) return;
      lastDsUrl = currentUrl;
      const convId = getConversationId(platform, currentUrl);
      if (!convId) return;
      if (dsProactiveTimer) clearTimeout(dsProactiveTimer);
      dsProactiveTimer = setTimeout(() => {
        if (historyInterceptedForConvId === convId) {
          log({ kind: "ds-proactive-skip", reason: "already-intercepted", convId: convId.slice(0, 8) });
          return;
        }
        if (!capturedDeepSeekHeaders) {
          log({ kind: "ds-proactive-skip", reason: "no-auth-headers", convId: convId.slice(0, 8) });
          return;
        }
        const histUrl = "/api/v0/chat/history_messages?chat_session_id=" + convId;
        log({ kind: "ds-proactive-trigger", convId: convId.slice(0, 8) });
        fetchDeepSeekHistoryFull(histUrl, capturedDeepSeekHeaders);
      }, 4000);
    }, 500);
  }

  function shouldIntercept(url) {
    if (platform.noiseUrlPatterns.some((re) => re.test(url))) return false;
    return platform.streamUrlPattern.test(url);
  }

  /** 判斷是否為對話歷史 GET/POST request（載入/切換對話時觸發）。
   *  注意：history 檢查優先於 noise，因為 Gemini 的 history URL 含 batchexecute
   *  但 noiseUrlPatterns 也含 batchexecute（用於排除 stream 攔截）。 */
  function shouldInterceptHistory(url) {
    if (!platform.historyUrlPattern) return false;
    return platform.historyUrlPattern.test(url);
  }

  // ---------------- fetch hook ----------------
  const origFetch = window.fetch;
  // 平台相關 URL 關鍵字（用於快速排除第三方追蹤/廣告請求）
  const RELEVANT_URL_RE = /api|conversation|completion|stream|batchexecute|rest\/app|chats|thread|organizations/i;
  window.fetch = function (input, init) {
    const url =
      typeof input === "string"
        ? input
        : input && input.url
        ? input.url
        : String(input);
    // 快速排除：與平台無關的 URL（如 doubleclick.net 廣告追蹤）直接 pass-through，
    // 不做任何攔截或處理，避免出現在 CSP 錯誤的堆疊追蹤中
    if (!RELEVANT_URL_RE.test(url)) {
      return origFetch.apply(this, arguments);
    }
    const promise = origFetch.apply(this, arguments);
    // 診斷：記錄所有 POST/fetch 呼叫（特別是含 api/conversation/completion/stream 的）
    if (/api|conversation|completion|stream|batchexecute/i.test(url)) {
      log({ kind: "fetch", method: (init && init.method) || "GET", url: url.length > 200 ? url.slice(0, 200) : url, matched: shouldIntercept(url) });
    }

    // Claude：從 API 請求中擷取 org ID（用於 SSR 場景的主動 history fetch）
    if (detectPlatformKey(platform) === "claude" && !capturedOrgId) {
      const orgId = extractClaudeOrgId(url);
      if (orgId) {
        capturedOrgId = orgId;
        log({ kind: "org-id-captured", orgId: orgId });
      }
    }

    // 攔截對話歷史 GET request（載入/切換對話時觸發）
    if (shouldInterceptHistory(url)) {
      log({ kind: "history-intercept", url: url.length > 200 ? url.slice(0, 200) : url });
      // 標記此對話已有 history 攔截，避免主動 fetch
      historyInterceptedForConvId = getConversationId(platform, url) || getConversationId(platform, location.href);
      promise.then((res) => {
        try {
          const cloned = res.clone();
          cloned.text().then((text) => {
            window.__AITC_LAST_HISTORY_BODY = text;
            log({ kind: "history-loaded", url: url.length > 80 ? url.slice(0, 80) : url, len: text.length });
            postHistoryBody(platform, url, text);
          }).catch(() => {});
        } catch (e) {
          log({ kind: "history-err", err: String(e).slice(0, 200) });
        }
      }).catch(() => {});
    }

    if (!shouldIntercept(url)) return promise;

    log({ kind: "fetch-intercept", url: url.length > 200 ? url.slice(0, 200) : url });

    // 捕獲請求 body（POST 到對話串流端點的內容）
    // 這是 API 真正收到的 prompt，包含系統提示、工具定義、完整對話歷史
    try {
      const platformKey = detectPlatformKey(platform);
      if (platformKey && init && init.body) {
        let bodyText = "";
        if (typeof init.body === "string") {
          bodyText = init.body;
        } else if (init.body instanceof Blob) {
          // Blob 需要非同步讀取，此處先略過（罕見）
        } else if (init.body instanceof ArrayBuffer) {
          bodyText = new TextDecoder("utf-8").decode(new Uint8Array(init.body));
        } else if (init.body instanceof FormData) {
          // FormData 不易序列化，略過
        } else if (init.body && init.body.toString) {
          bodyText = String(init.body);
        }
        if (bodyText) {
          window.__AITC_LAST_REQUEST_BODY = bodyText; // 診斷：保留原始 body
          const requestText = extractRequestText(platformKey, bodyText);
          log({
            kind: "request-body",
            url: url.length > 80 ? url.slice(0, 80) : url,
            bodyLen: bodyText.length,
            extractedLen: requestText.length,
          });
          postRequestBody(platform, url, requestText);
        }
      }
    } catch (e) {
      log({ kind: "request-body-err", err: String(e).slice(0, 200) });
    }

    promise
      .then((res) => {
        try {
          const ctype = res.headers.get("content-type") || "";
          log({ kind: "fetch-response", url: url.length > 120 ? url.slice(0, 120) : url, status: res.status, ctype });
          // 使用 clone + getReader 逐 chunk 讀取。
          // Claude/ChatGPT 在串流結束後會 abort 原始 fetch，導致 text() 拋出 AbortError。
          // 改為逐 chunk 累積，在 abort 時仍能解析已收到的資料。
          const cloned = res.clone();
          if (!cloned.body) {
            // 無 body stream（罕見），回退到 text()
            cloned.text().then((t) => {
              const u = parseBodyForUsage(platform, t);
              log({ kind: "fetch-usage", url: url.length > 80 ? url.slice(0, 80) : url, foundUsage: !!u, usage: u });
              if (u) postUsage(platform, url, u);
            }).catch(() => {});
            return;
          }
          const reader = cloned.body.getReader();
          const decoder = new TextDecoder("utf-8");
          let buffer = "";
          const shortUrl = url.length > 80 ? url.slice(0, 80) : url;
          function finalize(reason) {
            log({ kind: "fetch-body", url: shortUrl, len: buffer.length, reason, preview: buffer.slice(0, 400) });
            window.__AITC_LAST_BODY = buffer; // 診斷：保留完整 body
            const usage = parseBodyForUsage(platform, buffer);
            log({ kind: "fetch-usage", url: shortUrl, foundUsage: !!usage, usage: usage });
            if (usage) {
              postUsage(platform, url, usage);
            } else {
              // SSE 完成但無 usage（Claude web 不帶 usage）→ 通知 ISOLATED 立即估算
              postResponseComplete(platform, url);
            }
          }
          function pump() {
            reader.read().then(({ done, value }) => {
              if (done) { finalize("done"); return; }
              buffer += decoder.decode(value, { stream: true });
              pump();
            }).catch((e) => {
              // AbortError 時，已接收的 chunk 仍含完整 SSE 資料（含 usage）
              finalize("error:" + String(e).slice(0, 80));
            });
          }
          pump();
        } catch (e) { log({ kind: "fetch-err", err: String(e).slice(0, 200) }); }
      })
      .catch(() => {});

    return promise;
  };

  // ---------------- XMLHttpRequest hook ----------------
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__aitc_url = url;
    this.__aitc_method = method;
    return origOpen.apply(this, arguments);
  };
  // 攔截 setRequestHeader 以捕獲認證標頭（DeepSeek 需 userToken，
  // 主動 fetch 時需重播這些標頭，否則伺服器回傳 INVALID_TOKEN）
  const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (!this.__aitc_headers) this.__aitc_headers = {};
    this.__aitc_headers[name] = value;
    return origSetRequestHeader.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    const url = this.__aitc_url;
    if (url && /api|conversation|completion|stream|batchexecute|StreamGenerate/i.test(url)) {
      log({ kind: "xhr", method: this.__aitc_method, url: url.length > 200 ? url.slice(0, 200) : url, matched: shouldIntercept(url), historyMatched: shouldInterceptHistory(url) });
    }

    // 攔截對話歷史 request（Gemini 使用 XHR POST 載入歷史）
    if (url && shouldInterceptHistory(url)) {
      log({ kind: "xhr-history-intercept", url: url.length > 200 ? url.slice(0, 200) : url });
      // DeepSeek：全局保存認證標頭（供 SPA 場景主動 fetch 使用）
      if (detectPlatformKey(platform) === "deepseek" && this.__aitc_headers) {
        capturedDeepSeekHeaders = this.__aitc_headers;
      }
      this.addEventListener("load", () => {
        try {
          const text =
            typeof this.responseText === "string"
              ? this.responseText
              : this.response && this.response.toString
              ? this.response.toString()
              : "";
          window.__AITC_LAST_HISTORY_BODY = text;
          log({ kind: "xhr-history-loaded", url: url.length > 80 ? url.slice(0, 80) : url, len: text.length });
          postHistoryBody(platform, url, text);
          // DeepSeek cache_control:MERGE 場景：chat_messages 為空，客戶端使用快取
          // 主動發送不帶 cache 參數的請求以獲取完整對話
          if (detectPlatformKey(platform) === "deepseek" && text.indexOf("MERGE") >= 0) {
            fetchDeepSeekHistoryFull(url, this.__aitc_headers);
          }
        } catch (e) {
          log({ kind: "xhr-history-err", err: String(e).slice(0, 200) });
        }
      });
    }

    if (url && shouldIntercept(url)) {
      log({ kind: "xhr-intercept", url: url.length > 200 ? url.slice(0, 200) : url });

      // 捕獲請求 body（XHR POST 到串流端點的內容）
      try {
        const platformKey = detectPlatformKey(platform);
        if (platformKey && body != null) {
          let bodyText = "";
          if (typeof body === "string") {
            bodyText = body;
          } else if (body instanceof ArrayBuffer) {
            bodyText = new TextDecoder("utf-8").decode(new Uint8Array(body));
          } else if (body instanceof Blob) {
            // Blob 非同步，略過
          } else if (typeof body === "object" && body.toString) {
            bodyText = String(body);
          }
          if (bodyText) {
            window.__AITC_LAST_REQUEST_BODY = bodyText;
            const requestText = extractRequestText(platformKey, bodyText);
            log({
              kind: "xhr-request-body",
              url: url.length > 80 ? url.slice(0, 80) : url,
              bodyLen: bodyText.length,
              extractedLen: requestText.length,
            });
            postRequestBody(platform, url, requestText);
          }
        }
      } catch (e) {
        log({ kind: "xhr-request-body-err", err: String(e).slice(0, 200) });
      }

      this.addEventListener("load", () => {
        try {
          const text =
            typeof this.responseText === "string"
              ? this.responseText
              : this.response && this.response.toString
              ? this.response.toString()
              : "";
          const shortUrl = url.length > 80 ? url.slice(0, 80) : url;
          window.__AITC_LAST_BODY = text; // 診斷：保留完整 body
          log({ kind: "xhr-body", url: shortUrl, len: text.length, preview: text.slice(0, 400) });
          const usage = parseBodyForUsage(platform, text);
          log({ kind: "xhr-usage", url: shortUrl, foundUsage: !!usage, usage: usage });
          if (usage) {
            postUsage(platform, url, usage);
          } else {
            // SSE/串流完成但無 usage → 通知 ISOLATED 立即估算
            postResponseComplete(platform, url);
          }
        } catch (e) { log({ kind: "xhr-err", err: String(e).slice(0, 200) }); }
      });
    }
    return origSend.apply(this, arguments);
  };

  // 診斷：暴露日誌清除函式
  window.__AITC_CLEAR_LOG = function () { window.__AITC_LOG = []; };
})();
