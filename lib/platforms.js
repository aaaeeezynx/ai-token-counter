// lib/platforms.js
// 各平台（Claude / ChatGPT / Gemini / DeepSeek / Grok / Perplexity / Qwen）
// URL 模式、DOM 選擇器、usage 欄位路徑、預設 Context Window。
// 內建 v1.3.0 經驗：world:MAIN 繞過 CSP、ChatGPT SSE 逐行掃描、噪音 URL 過濾、多格式 usage 統一處理。
(function () {
  "use strict";

  const PLATFORMS = {
    claude: {
      id: "claude",
      label: "Claude",
      defaultContextWindow: 200000,
      hostMatches: ["claude.ai"],
      // 對話 URL：/chat/<conversation_id> 或新版 /new'
      conversationUrlPattern: /\/chat\/([a-f0-9-]+)/i,
      // SSE 串流端點
      streamUrlPattern:
        /\/api\/organizations\/[^/]+\/chat_conversations\/[^/]+\/completion/i,
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
      // 對話內容選擇器（用於 WASM 估算回退）
      // 實機驗證：Claude 助理訊息在 div.font-claude-response（無 data-testid）。
      // 使用 ~= 全詞匹配，避免誤抓內層 p.font-claude-response-body。
      turnSelectors: {
        user: '[data-testid="user-message"]',
        assistant: '[class~="font-claude-response"]',
      },
      tokenizerFamily: "cl100k_base",
    },
    chatgpt: {
      id: "chatgpt",
      label: "ChatGPT",
      defaultContextWindow: 128000,
      hostMatches: ["chatgpt.com", "chat.openai.com"],
      conversationUrlPattern: /\/c\/([a-f0-9-]+)/i,
      // 主要對話串流 API（僅此 URL 解析 usage）
      // 實機驗證：免費版使用 backend-anon/f/conversation，付費版使用 backend-api/conversation
      streamUrlPattern: /\/backend-(api|anon)\/(f\/)?conversation$/i,
      // 需過濾的非對話後台 URL（v1.3.0 經驗）
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
      turnSelectors: {
        user: '[data-message-author-role="user"]',
        assistant: '[data-message-author-role="assistant"]',
      },
      tokenizerFamily: "o200k_base",
    },
    gemini: {
      id: "gemini",
      label: "Gemini",
      defaultContextWindow: 1000000,
      hostMatches: ["gemini.google.com"],
      conversationUrlPattern: /\/app\/([a-f0-9]+)/i,
      // 實機驗證：串流端點為 StreamGenerate（XHR POST，非 batchexecute）
      streamUrlPattern: /\/StreamGenerate\b/i,
      // batchexecute 為非串流的 RPC（metadata、UI 狀態等），過濾掉
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
      // 實機驗證：Gemini 使用 Angular 自訂元素 user-query / model-response
      turnSelectors: {
        user: 'user-query',
        assistant: 'model-response',
      },
      // Gemini 無官方 tiktoken BPE，估算誤差較大（僅作回退）
      tokenizerFamily: "cl100k_base",
    },
    deepseek: {
      id: "deepseek",
      label: "DeepSeek",
      defaultContextWindow: 64000,
      hostMatches: ["chat.deepseek.com"],
      // 對話 URL：/a/chat/s/{session_id}
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
      // SSE usage：accumulated_token_usage（總 token 數，含 input + output）
      // 注意：DeepSeek 使用 JSON Patch 格式更新 usage，需特殊處理（見 inject.js）
      usagePaths: [
        "v.response.accumulated_token_usage",
      ],
      // DeepSeek DOM：所有訊息都是 div.ds-message
      // 用戶訊息無 .ds-markdown 子元素，助理訊息有 .ds-markdown.ds-assistant-message-main-content
      turnSelectors: {
        user: 'div.ds-message:not(:has(.ds-markdown))',
        assistant: '.ds-markdown.ds-assistant-message-main-content',
      },
      // DeepSeek 使用自有 BPE，cl100k_base 為近似值
      tokenizerFamily: "cl100k_base",
    },
    grok: {
      id: "grok",
      label: "Grok",
      defaultContextWindow: 131072,
      hostMatches: ["grok.com"],
      // 對話 URL：/c/{conversation_id}（含可選 ?rid= 查詢參數）
      conversationUrlPattern: /\/c\/([a-f0-9-]+)/i,
      // 串流端點（兩種）：
      //   新對話：POST /rest/app-chat/conversations/new
      //   後續訊息：POST /rest/app-chat/conversations/{id}/responses
      // 不匹配 load-responses / response-node（歷史載入用）
      streamUrlPattern:
        /\/rest\/app-chat\/conversations\/(?:new|[a-f0-9-]+\/responses)(?:\?|$)/i,
      // GET/POST 對話歷史：POST /rest/app-chat/conversations/{id}/load-responses
      // body: {"responseIds":[...]}，回應含完整訊息
      historyUrlPattern:
        /\/rest\/app-chat\/conversations\/[a-f0-9-]+\/load-responses(?:\?|$)/i,
      noiseUrlPatterns: [
        /\/rest\/app-chat\/conversations\?/i, // 對話列表
        /\/rest\/app-chat\/conversations_v2\//i, // metadata
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
      // 使用 request body + DOM history + WASM tokenizer 計算（同 Claude/ChatGPT 模式）
      usagePaths: [],
      // Grok DOM：用戶/助理訊息皆為 div.message-bubble[data-testid]
      turnSelectors: {
        user: 'div[data-testid="user-message"]',
        assistant: 'div[data-testid="assistant-message"]',
      },
      // Grok 使用自有 BPE，cl100k_base 為近似值
      tokenizerFamily: "cl100k_base",
    },
    perplexity: {
      id: "perplexity",
      label: "Perplexity",
      defaultContextWindow: 127072,
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
        /\/rest\/thread\/list_/i, // 對話列表
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
      // Perplexity DOM：
      // 用戶訊息：div[class*="group/query"]（whitespace-pre-line）
      // 助理訊息：div.prose（dark:prose-invert）
      turnSelectors: {
        user: 'div[class*="group/query"]',
        assistant: 'div.prose',
      },
      // Perplexity 使用自有模型，cl100k_base 為近似值
      tokenizerFamily: "cl100k_base",
    },
    qwen: {
      id: "qwen",
      label: "Qwen",
      defaultContextWindow: 1000000,
      hostMatches: ["chat.qwen.ai"],
      // 對話 URL：/c/{chat_id}
      conversationUrlPattern: /\/c\/([a-f0-9-]+)/i,
      // 串流端點：POST /api/v2/chat/completions?chat_id={id}（SSE）
      // request body: { stream, model, messages: [{role, content, ...}], ... }
      streamUrlPattern: /\/api\/v2\/chat\/completions(?:\?|$)/i,
      // GET 對話歷史：/api/v2/chats/{id}
      // 回應結構：{ data: { chat: { history: { messages: { id: { role, content, content_list, modelName, ... } } } } } }
      // 注意：messages 是物件而非陣列，key 是 message id
      historyUrlPattern: /\/api\/v2\/chats\/[a-f0-9-]+$/i,
      noiseUrlPatterns: [
        /\/api\/v2\/chats\/new/i, // 新建對話
        /\/api\/v2\/chats\/\?/i, // 對話列表
        /\/api\/v2\/users\//i,
        /\/api\/v2\/configs\//i,
        /\/api\/v2\/notifications\//i,
        /\/api\/v2\/library\//i,
        /\/aplus\.qwen\.ai/i, // 埋點
        /\/fourier\.(alibaba|taobao)\.com/i,
        /\/pagead2\.googlesyndication/i,
        /\/google\.com\/pagead/i,
        /\/googletagmanager/i,
        /\/google-analytics/i,
      ],
      // Qwen SSE 提供 usage 欄位：input_tokens、output_tokens、total_tokens
      usagePaths: [
        "usage.input_tokens",
        "usage.output_tokens",
        "usage.total_tokens",
      ],
      // Qwen DOM：
      // 用戶訊息：div.qwen-chat-message-user
      // 助理訊息：div.qwen-chat-message-assistant
      turnSelectors: {
        user: 'div.qwen-chat-message-user',
        assistant: 'div.qwen-chat-message-assistant',
      },
      // Qwen 使用自有 BPE，cl100k_base 為近似值（SSE 已提供精確 usage）
      tokenizerFamily: "cl100k_base",
    },
  };

  function getByPath(obj, path) {
    return path.split(".").reduce((acc, key) => {
      if (acc && typeof acc === "object" && key in acc) return acc[key];
      return undefined;
    }, obj);
  }

  const AITC = (globalThis.AITC = globalThis.AITC || {});

  AITC.platforms = {
    all: PLATFORMS,

    /** 依當前 location 偵測平台，回傳 platform 物件或 null */
    detectPlatform(loc) {
      const host = (loc && loc.host) || globalThis.location.host;
      for (const key in PLATFORMS) {
        const p = PLATFORMS[key];
        if (p.hostMatches.some((h) => host === h || host.endsWith("." + h))) {
          return p;
        }
      }
      return null;
    },

    /** 由 URL 解析交談 ID */
    getConversationId(platform, url) {
      if (!platform) return null;
      const m = (url || globalThis.location.href).match(
        platform.conversationUrlPattern
      );
      return m ? m[1] : null;
    },

    /** 判斷是否為對話串流 URL */
    isStreamUrl(platform, url) {
      if (!platform) return false;
      return platform.streamUrlPattern.test(url);
    },

    /** 判斷是否為應忽略的噪音 URL */
    isNoiseUrl(platform, url) {
      if (!platform) return false;
      return platform.noiseUrlPatterns.some((re) => re.test(url));
    },

    /** 由 SSE chunk / JSON 物件統一擷取 usage（input/output/total） */
    extractUsage(platform, parsed) {
      if (!parsed || typeof parsed !== "object") return null;
      const cfg = platform || { usagePaths: [] };
      let inputTokens = null;
      let outputTokens = null;
      let totalTokens = null;

      for (const path of cfg.usagePaths || []) {
        const val = getByPath(parsed, path);
        if (val == null) continue;
        if (/input|prompt/i.test(path)) inputTokens = val;
        else if (/output|candidates|completion/i.test(path))
          outputTokens = val;
        else if (/total|accumulated/i.test(path)) totalTokens = val;
      }

      // DeepSeek JSON Patch 格式：{p:"response", o:"BATCH", v:[{p:"accumulated_token_usage", v:69}]}
      if (totalTokens == null && parsed.o === "BATCH" && Array.isArray(parsed.v)) {
        for (const patch of parsed.v) {
          if (patch && patch.p === "accumulated_token_usage" && typeof patch.v === "number") {
            totalTokens = patch.v;
            break;
          }
        }
      }

      // Gemini usageMetadata.totalTokenCount 直接代表總量
      if (totalTokens == null) {
        const totalPath = (cfg.usagePaths || []).find((p) => /total|accumulated/i.test(p));
        if (totalPath) totalTokens = getByPath(parsed, totalPath);
      }

      if (inputTokens == null && outputTokens == null && totalTokens == null)
        return null;

      if (totalTokens == null && inputTokens != null && outputTokens != null)
        totalTokens = inputTokens + outputTokens;
      if (inputTokens == null && totalTokens != null && outputTokens != null)
        inputTokens = totalTokens - outputTokens;
      if (outputTokens == null && totalTokens != null && inputTokens != null)
        outputTokens = totalTokens - inputTokens;

      return {
        inputTokens,
        outputTokens,
        totalTokens,
        raw: parsed,
      };
    },

    /** 抓取可見對話文字（用於 WASM/啟發式估算回退） */
    scrapeConversationText(platform) {
      if (!platform || !platform.turnSelectors) return "";
      const parts = [];
      for (const role of ["user", "assistant"]) {
        const sel = platform.turnSelectors[role];
        if (!sel) continue;
        try {
          document.querySelectorAll(sel).forEach((el) => {
            const t = (el.innerText || "").trim();
            if (t) parts.push(t);
          });
        } catch (_) {}
      }
      return parts.join("\n\n");
    },

    /** 抓取最新（最後一則）助理回覆文字，用於計算 output_tokens。
     *  在 request-body 攔截已提供 input_tokens 的情況下使用。 */
    scrapeLatestAssistantText(platform) {
      if (!platform || !platform.turnSelectors) return "";
      const sel = platform.turnSelectors.assistant;
      if (!sel) return "";
      try {
        const els = document.querySelectorAll(sel);
        if (els.length === 0) return "";
        const last = els[els.length - 1];
        return (last.innerText || "").trim();
      } catch (_) {
        return "";
      }
    },

    /** 由 host 反查 platform 物件（給 inject.js MAIN 世界用） */
    getByHost(host) {
      for (const key in PLATFORMS) {
        const p = PLATFORMS[key];
        if (p.hostMatches.some((h) => host === h || host.endsWith("." + h)))
          return p;
      }
      return null;
    },
  };
})();
