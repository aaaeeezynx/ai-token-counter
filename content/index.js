// content/index.js
// 執行於 ISOLATED 世界。協調者：監聽 MAIN 世界 inject 的 usage、偵測平台/模型、
// 混合 Token 計數（攔截優先、WASM/啟發式估算回退）、偵測對話邊界、更新 UI、同步 background。
(function () {
  "use strict";

  const AITC = globalThis.AITC || {};
  if (!AITC.platforms || !AITC.storage || !AITC.tokenizer || !AITC.ui || !AITC.rateLimit) {
    // lib 未正確載入，放棄
    return;
  }

  const state = {
    platform: null,
    conversationId: null,
    contextWindow: 0,
    // 攔截值（精準）
    lastUsage: null, // { inputTokens, outputTokens, totalTokens, ts }
    used: 0,
    inputTokens: null,
    outputTokens: null,
    source: null, // 'intercept' | 'estimate'
    lastInterceptTs: 0,
    pendingOutputUpdate: false, // response-complete 已到達，等待 handleRequestBody 完成後更新 output
  };

  // 速率限制追蹤狀態
  const rlState = {
    settings: null,       // rateLimitSettings
    events: [],           // 時間序列 [{ ts, tokens, conversationId }]
    limit: null,          // 當前平台的速率限制定義
    usage: null,          // 當前窗口使用量 { count, totalTokens, resetInMs }
    predict: null,        // 預測 { etaMin, remainingMsgs, tokensPerMin, ... }
    lastRecordTs: 0,      // 上次記錄事件的時間（去重用）
    lastRecordConvId: null,
  };

  let settings = null;
  let estimateTimer = null;
  let rateLimitTimer = null;
  const INTERCEPT_FRESH_MS = 60000; // 攔截值有效期

  function sendToBackground(msg) {
    try {
      chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
    } catch (_) {}
  }

  function resetConversation(newId) {
    state.conversationId = newId;
    state.lastUsage = null;
    state.used = 0;
    state.inputTokens = null;
    state.outputTokens = null;
    state.source = null;
    state.lastInterceptTs = 0;
    state.pendingOutputUpdate = false;
    render();
  }

  function render() {
    AITC.ui.update({
      platform: state.platform,
      contextWindow: state.contextWindow,
      used: state.used,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      source: settings && settings.showSourceBadge ? state.source : null,
      showSourceBadge: settings ? settings.showSourceBadge : true,
      // 速率限制狀態
      rateLimit: rlState.limit,
      rateLimitUsage: rlState.usage,
      rateLimitPredict: rlState.predict,
    });
  }

  // ---- 速率限制追蹤 ----
  /** 記錄一筆速率限制事件（每次使用者發送訊息時呼叫）
   *  去重：同一對話在 30 秒內只記錄一次（避免 inject 重複觸發） */
  async function recordRateLimitEvent(tokens) {
    if (!state.platform || !rlState.limit) return;
    const now = Date.now();
    const convId = state.conversationId;
    // 去重：同一對話 30 秒內不重複記錄
    if (
      rlState.lastRecordConvId === convId &&
      now - rlState.lastRecordTs < 30000
    ) {
      return;
    }
    rlState.lastRecordTs = now;
    rlState.lastRecordConvId = convId;
    try {
      await AITC.storage.recordRateLimitEvent(state.platform.id, {
        ts: now,
        tokens: tokens || 0,
        conversationId: convId,
      });
      await refreshRateLimit();
    } catch (_) {}
  }

  /** 重新計算當前窗口使用量與預測 */
  async function refreshRateLimit() {
    if (!state.platform || !rlState.settings) return;
    rlState.limit = AITC.rateLimit.getLimit(
      state.platform.id,
      rlState.settings
    );
    if (!rlState.limit || rlState.limit.messageLimit <= 0) {
      rlState.usage = null;
      rlState.predict = null;
      render();
      return;
    }
    try {
      rlState.events = await AITC.storage.getRateLimitEvents(
        state.platform.id
      );
    } catch (_) {
      rlState.events = [];
    }
    rlState.usage = AITC.rateLimit.computeUsage(rlState.events, rlState.limit);
    rlState.predict = AITC.rateLimit.predict(
      rlState.events,
      rlState.limit,
      rlState.usage
    );
    render();
  }

  function reportToBackground() {
    const limit = state.contextWindow || 0;
    const pct = limit > 0 ? (state.used / limit) * 100 : 0;
    sendToBackground({
      type: "status",
      platformId: state.platform ? state.platform.id : null,
      platformLabel: state.platform ? state.platform.label : null,
      conversationId: state.conversationId,
      contextWindow: limit,
      used: state.used,
      inputTokens: state.inputTokens,
      outputTokens: state.outputTokens,
      pct,
      source: state.source,
    });
  }

  // ---- 攔截 usage 處理 ----
  function handleInterceptedUsage(payload) {
    const usage = payload && payload.usage;
    if (!usage) return;
    // 確認屬於當前對話（若帶 conversationId 且不同，切換對話）
    if (payload.conversationId && payload.conversationId !== state.conversationId) {
      resetConversation(payload.conversationId);
    }
    state.lastUsage = usage;
    state.lastUsage.ts = payload.ts || Date.now();
    state.lastInterceptTs = state.lastUsage.ts;

    // 以最新 usage 的 total（或 input+output）作為當前 context 使用量
    const total =
      usage.totalTokens != null
        ? usage.totalTokens
        : (usage.inputTokens || 0) + (usage.outputTokens || 0);
    state.used = total || state.used;
    // 僅在 usage 提供值時覆蓋（DeepSeek 只提供 total，不覆蓋已由 request-body 計算的 input/output）
    if (usage.inputTokens != null) state.inputTokens = usage.inputTokens;
    if (usage.outputTokens != null) state.outputTokens = usage.outputTokens;
    // 若有 total 但 usage 未提供 output，從現有 input 推算（DeepSeek 場景）
    if (usage.totalTokens != null && usage.outputTokens == null && state.inputTokens != null) {
      state.outputTokens = Math.max(0, usage.totalTokens - state.inputTokens);
    }
    state.source = "intercept";
    render();
    reportToBackground();
  }

  // ---- 攔截 request body 處理（精準 input_tokens 估算）----
  // inject.js 從 POST 請求 body 中擷取 request 文字（含系統提示、工具定義、最新 prompt）。
  // 此處將 request 文字與 DOM 抓取的對話歷史合併，用 tokenizer 精確計算 input_tokens。
  // output_tokens 不在此計算（助理回覆尚未生成），由 response-complete 事件觸發更新。
  async function handleRequestBody(payload) {
    if (!payload || !payload.bodyText) return;
    if (payload.conversationId && payload.conversationId !== state.conversationId) {
      resetConversation(payload.conversationId);
    }

    // 立即標記為攔截模式，防止 response-complete 在 await 期間觸發 runEstimate 覆蓋
    state.source = "intercept";
    state.lastInterceptTs = Date.now();

    // 1. 從 DOM 抓取完整對話歷史（user + assistant，排除最新助理回覆若為空）
    const domText = AITC.platforms.scrapeConversationText(state.platform);

    // 2. 合併 request body 文字（含工具定義、系統提示、最新 prompt）與 DOM 歷史
    const combinedText = payload.bodyText + "\n\n" + domText;

    // 3. 用 WASM tokenizer 精確計算 input_tokens
    const { count: inputCount } = await AITC.tokenizer.countTokens(
      combinedText,
      state.platform.tokenizerFamily
    );

    // await 期間 watchUrlChange 可能因 URL 變化觸發 resetConversation 清除狀態
    // （Gemini 新對話會在發送瞬間變更 URL），重新確認攔截模式
    state.source = "intercept";
    state.lastInterceptTs = Date.now();

    // 4. 只更新 input_tokens，output_tokens 留待 response-complete 時更新
    state.inputTokens = inputCount;
    state.used = inputCount + (state.outputTokens || 0);

    // 若 response-complete 已先到達，立即更新 output_tokens
    if (state.pendingOutputUpdate) {
      state.pendingOutputUpdate = false;
      updateOutputTokensWithRetry(0);
    }

    render();
    reportToBackground();
    diagLog("request-body-done", { inputCount, used: state.used, input: state.inputTokens, output: state.outputTokens, convId: state.conversationId });
    // 記錄速率限制事件（使用者發送訊息時，以 input token 數記錄）
    recordRateLimitEvent(inputCount);
  }

  // ---- 攔截對話歷史 GET response 處理 ----
  // 當頁面載入或切換對話時，inject.js 攔截 GET request 的回應 body，
  // 從中擷取完整對話歷史文字，用 tokenizer 計算 input_tokens。
  // 這比 DOM 估算更準確，因為 JSON 回應包含完整的對話歷史（不受 DOM 渲染影響）。
  // output_tokens 也從歷史 JSON 中擷取（最新助理回覆），不依賴 DOM 渲染。
  async function handleHistoryBody(payload) {
    if (!payload || !payload.bodyText) return;
    if (payload.conversationId && payload.conversationId !== state.conversationId) {
      resetConversation(payload.conversationId);
    }

    // 立即標記為攔截模式，防止 await 期間被 runEstimate 覆蓋
    state.source = "intercept";
    state.lastInterceptTs = Date.now();

    // 從歷史 JSON 中擷取完整對話文字（user + assistant）
    let historyText = extractHistoryText(payload.bodyText, state.platform.id);
    diagLog("history-extract", { historyTextLen: historyText.length, bodyLen: payload.bodyText.length, convId: payload.conversationId });

    // 若歷史 JSON 無文字（如 DeepSeek cache_control:MERGE 場景，chat_messages 為空），
    // 退回 DOM 抓取（DeepSeek 有渲染對話到 DOM）
    // 但 DOM 可能尚未渲染完成，需等待後重試
    // 策略：先等待 2 秒讓 DOM 開始渲染，然後多次抓取取最長結果（DOM 可能漸進渲染）
    if (!historyText) {
      // DeepSeek cache_control:MERGE 場景：chat_messages 為空，inject.js 已觸發 proactive fetch
      // 不做 DOM fallback（會被後續 proactive fetch 的精確結果覆蓋），直接等待完整 history-body 到達
      if (payload.bodyText && payload.bodyText.indexOf("MERGE") >= 0) {
        diagLog("history-merge-skip", { bodyLen: payload.bodyText.length });
        return;
      }
      await new Promise((r) => setTimeout(r, 2000));
      let bestText = "";
      for (let i = 0; i < 5; i++) {
        // 每次重試都更新 lastInterceptTs，防止 runEstimate / resetConversation 覆蓋
        state.lastInterceptTs = Date.now();
        const text = AITC.platforms.scrapeConversationText(state.platform);
        if (text.length > bestText.length) bestText = text;
        // 若文字長度穩定（不再增加），停止重試
        if (text.length > 0 && text.length === bestText.length && i > 0) {
          await new Promise((r) => setTimeout(r, 500));
          state.lastInterceptTs = Date.now();
          const text2 = AITC.platforms.scrapeConversationText(state.platform);
          if (text2.length <= text.length) break;
          if (text2.length > bestText.length) bestText = text2;
        }
        await new Promise((r) => setTimeout(r, 500));
      }
      historyText = bestText;
      diagLog("history-dom-fallback", { historyTextLen: historyText.length });
    }
    if (!historyText) {
      diagLog("history-empty-return", { reason: "no history text after DOM fallback" });
      return;
    }

    // 從歷史 JSON 中擷取最新助理回覆（不依賴 DOM，避免渲染延遲問題）
    let latestAssistant = extractLatestAssistantFromHistory(
      payload.bodyText,
      state.platform.id
    );
    // 若歷史 JSON 無助理回覆，從 DOM 抓取
    if (!latestAssistant) {
      latestAssistant = AITC.platforms.scrapeLatestAssistantText(state.platform);
    }

    // 嘗試從歷史 JSON 中擷取精確 token 使用量（DeepSeek accumulated_token_usage）
    // 這是伺服器計算的精確值，含系統提示+工具定義，比文字計數更準確
    const exactUsage = extractHistoryUsage(payload.bodyText, state.platform.id);
    diagLog("history-exact-usage", { hasExactUsage: !!exactUsage, exactUsage });

    let totalCount, outputCount;
    if (exactUsage && exactUsage.totalTokens != null) {
      // 使用伺服器提供的精確 token 數
      totalCount = exactUsage.totalTokens;
      outputCount = exactUsage.outputTokens != null ? exactUsage.outputTokens : 0;
    } else {
      // 退回文字計數
      const { count } = await AITC.tokenizer.countTokens(
        historyText,
        state.platform.tokenizerFamily
      );
      totalCount = count;
      outputCount = 0;
      if (latestAssistant) {
        const out = await AITC.tokenizer.countTokens(
          latestAssistant,
          state.platform.tokenizerFamily
        );
        outputCount = out.count;
      }
    }

    // await 期間 watchUrlChange 可能觸發 resetConversation 清除狀態，重新確認攔截模式
    state.source = "intercept";
    state.lastInterceptTs = Date.now();

    // used = 完整對話歷史總 token 數
    // input = 總數扣除最新助理回覆（即下一次發送時的 context input）
    // output = 最新助理回覆
    state.used = totalCount;
    state.inputTokens = totalCount - outputCount;
    state.outputTokens = outputCount;
    render();
    reportToBackground();
    diagLog("history-body-done", { totalCount, outputCount, used: state.used, input: state.inputTokens, output: state.outputTokens, convId: state.conversationId, exact: !!exactUsage });
  }

  /** 從對話歷史 JSON 中擷取最新助理回覆文字。
   *  ChatGPT: mapping 中 role=assistant 的最後一則訊息
   *  Claude: chat_messages 中 sender=assistant 的最後一則
   *  Gemini: batchexecute 回應中最後一個 turn 的助理回覆 */
  function extractLatestAssistantFromHistory(body, platformId) {
    if (!body) return "";
    if (platformId === "gemini") {
      return extractLatestGeminiAssistant(body);
    }
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      return "";
    }

    let lastAssistant = "";
    if (platformId === "chatgpt") {
      if (parsed.mapping && typeof parsed.mapping === "object") {
        for (const nodeId in parsed.mapping) {
          const node = parsed.mapping[nodeId];
          if (!node || !node.message) continue;
          const msg = node.message;
          const role = msg.author && msg.author.role;
          if (role !== "assistant") continue;
          if (msg.content && Array.isArray(msg.content.parts)) {
            const text = msg.content.parts
              .filter((p) => typeof p === "string")
              .join("");
            if (text.trim()) lastAssistant = text;
          }
        }
      }
    } else if (platformId === "claude") {
      const msgs = parsed.chat_messages || parsed.messages || [];
      if (Array.isArray(msgs)) {
        for (const m of msgs) {
          if (!m) continue;
          const sender = m.sender || m.role;
          if (sender !== "assistant") continue;
          if (typeof m.text === "string" && m.text.trim()) {
            lastAssistant = m.text;
          } else if (typeof m.content === "string" && m.content.trim()) {
            lastAssistant = m.content;
          } else if (Array.isArray(m.content)) {
            const text = m.content
              .map((c) =>
                typeof c === "string" ? c : c && c.text ? c.text : ""
              )
              .join("");
            if (text.trim()) lastAssistant = text;
          }
        }
      }
    } else if (platformId === "deepseek") {
      // DeepSeek: role 為 "ASSISTANT"（大寫），content 在 fragments 中
      const msgs =
        parsed.messages ||
        (parsed.data && parsed.data.messages) ||
        (parsed.data && parsed.data.biz_data && parsed.data.biz_data.chat_messages) ||
        [];
      if (Array.isArray(msgs)) {
        for (const m of msgs) {
          if (!m) continue;
          const role = (m.role || "").toUpperCase();
          if (role !== "ASSISTANT") continue;
          // 先嘗試 content 欄位
          if (typeof m.content === "string" && m.content.trim()) {
            lastAssistant = m.content;
          }
          // 再嘗試 fragments 陣列
          if (Array.isArray(m.fragments)) {
            const text = m.fragments
              .map((f) => (f && typeof f.content === "string" ? f.content : ""))
              .join("");
            if (text.trim()) lastAssistant = text;
          }
        }
      }
    } else if (platformId === "grok") {
      // Grok: { responses: [{ responseId, message, sender: "human"|"ASSISTANT", ... }] }
      // sender 為 "ASSISTANT"（大寫）的是助理回覆
      const msgs = parsed.responses || [];
      if (Array.isArray(msgs)) {
        for (const m of msgs) {
          if (!m) continue;
          const sender = (m.sender || "").toUpperCase();
          if (sender !== "ASSISTANT") continue;
          if (typeof m.message === "string" && m.message.trim()) {
            lastAssistant = m.message;
          }
        }
      }
    } else if (platformId === "perplexity") {
      // Perplexity: { entries: [{ query_str, display_model, blocks: [{ markdown_block: { answer } }] }] }
      // 每個 entry 代表一輪對話：query_str 是用戶輸入，blocks[].markdown_block.answer 是助理回覆
      // 注意：每個 entry 有兩個 markdown_block（ask_text_0_markdown 與 ask_text），內容相同，只取前者避免重複
      const entries = parsed.entries || [];
      if (Array.isArray(entries)) {
        for (const entry of entries) {
          if (!entry || !Array.isArray(entry.blocks)) continue;
          for (const block of entry.blocks) {
            if (
              block &&
              block.intended_usage === "ask_text_0_markdown" &&
              block.markdown_block &&
              typeof block.markdown_block.answer === "string" &&
              block.markdown_block.answer.trim()
            ) {
              lastAssistant = block.markdown_block.answer;
            }
          }
        }
      }
    } else if (platformId === "qwen") {
      // Qwen: { data: { chat: { history: { messages: { id: { role, content, content_list, modelName, ... } } } } } }
      // messages 是物件而非陣列，key 是 message id
      // 助理訊息的 content 可能為空，實際內容在 content_list 陣列中
      const msgs = parsed?.data?.chat?.history?.messages;
      if (msgs && typeof msgs === "object") {
        for (const mid in msgs) {
          const m = msgs[mid];
          if (!m || m.role !== "assistant") continue;
          // 優先取 content（若非空）
          if (typeof m.content === "string" && m.content.trim()) {
            lastAssistant = m.content;
          } else if (Array.isArray(m.content_list)) {
            // 組合 content_list 中所有非空 content
            const txt = m.content_list
              .map((c) => (c && typeof c.content === "string" ? c.content : ""))
              .filter((s) => s.trim())
              .join("\n");
            if (txt.trim()) lastAssistant = txt;
          }
        }
      }
    }
    return lastAssistant;
  }

  /** 從對話歷史 JSON 中擷取精確 token 使用量（伺服器提供）。
   *  DeepSeek: chat_messages 中每則訊息有 accumulated_token_usage（累計總 token 數）。
   *  最後一則 ASSISTANT 訊息的 accumulated_token_usage = 當前 context 總量（含系統提示+工具定義）。
   *  最後一則 USER 訊息的 accumulated_token_usage = 發送時的 input。
   *  output = 最後 ASSISTANT 的累計 - 最後 USER 的累計。
   *  其他平台回傳 null（使用文字計數或 SSE usage）。 */
  function extractHistoryUsage(body, platformId) {
    if (!body) return null;
    if (platformId !== "deepseek") return null;
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      return null;
    }
    const msgs =
      (parsed.data && parsed.data.biz_data && parsed.data.biz_data.chat_messages) ||
      (parsed.data && parsed.data.messages) ||
      parsed.messages ||
      [];
    if (!Array.isArray(msgs) || msgs.length === 0) return null;

    let lastTotal = null;
    let lastUserTotal = null;
    for (const m of msgs) {
      if (!m || typeof m.accumulated_token_usage !== "number") continue;
      lastTotal = m.accumulated_token_usage;
      const role = (m.role || "").toUpperCase();
      if (role === "USER") lastUserTotal = m.accumulated_token_usage;
    }
    if (lastTotal == null) return null;

    const totalTokens = lastTotal;
    let inputTokens = null;
    let outputTokens = null;
    if (lastUserTotal != null) {
      inputTokens = lastUserTotal;
      outputTokens = Math.max(0, lastTotal - lastUserTotal);
    }
    return { totalTokens, inputTokens, outputTokens };
  }

  /** 從 Gemini batchexecute 回應中擷取最新助理回覆。
   *  複用 extractGeminiHistoryText 的解析邏輯，但只回傳最後一個助理回覆。 */
  function extractLatestGeminiAssistant(body) {
    if (!body) return "";
    let text = body;
    if (text.startsWith(")]}'")) text = text.slice(4);
    const lines = text.split(/\r?\n/);
    let parsed = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^\d+$/.test(trimmed)) continue;
      try {
        parsed = JSON.parse(trimmed);
        break;
      } catch (_) {}
    }
    if (!parsed) return "";

    let lastAssistant = "";
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!Array.isArray(item) || item.length < 3) continue;
        if (item[0] !== "wrb.fr" || item[1] !== "hNvQHb") continue;
        const innerStr = item[2];
        if (typeof innerStr !== "string") continue;
        let inner;
        try {
          inner = JSON.parse(innerStr);
        } catch (_) {
          continue;
        }
        if (!Array.isArray(inner)) continue;

        let turns = inner;
        if (
          inner.length >= 1 &&
          Array.isArray(inner[0]) &&
          inner[0].length >= 1 &&
          Array.isArray(inner[0][0])
        ) {
          turns = inner[0];
        }

        for (const turn of turns) {
          if (!Array.isArray(turn) || turn.length < 4) continue;
          // turn[3][0] 是實際助理回應候選（其他元素是引用、metadata 等）
          const asstResponses = turn[3];
          if (Array.isArray(asstResponses) && asstResponses.length >= 1) {
            const r = asstResponses[0];
            if (Array.isArray(r)) {
              let candidate = r;
              if (r.length >= 1 && Array.isArray(r[0])) candidate = r[0];
              if (
                candidate.length >= 2 &&
                Array.isArray(candidate[1]) &&
                typeof candidate[1][0] === "string" &&
                candidate[1][0].trim()
              ) {
                lastAssistant = candidate[1][0];
              }
            }
          }
        }
      }
    }
    return lastAssistant;
  }

  /** 從對話歷史 JSON 中擷取對話文字。
   *  ChatGPT: { mapping: { id: { message: { author: { role }, content: { parts: [...] } } } } }
   *  Claude: 結構可能不同，需實機驗證
   *  Gemini: batchexecute 回應，含 )]}' 前綴和 chunked encoding */
  function extractHistoryText(body, platformId) {
    if (!body) return "";
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch (_) {
      // Gemini 的 batchexecute 回應有特殊前綴，需特殊處理
      if (platformId === "gemini") {
        return extractGeminiHistoryText(body);
      }
      return body;
    }

    const parts = [];

    if (platformId === "chatgpt") {
      // ChatGPT: mapping 物件，每個 node 有 message.author.role 和 message.content.parts
      if (parsed.mapping && typeof parsed.mapping === "object") {
        for (const nodeId in parsed.mapping) {
          const node = parsed.mapping[nodeId];
          if (!node || !node.message) continue;
          const msg = node.message;
          const role = msg.author && msg.author.role;
          if (!role) continue;
          // 只取 user 和 assistant 的內容（系統提示通常為空）
          if (role !== "user" && role !== "assistant") continue;
          if (msg.content && Array.isArray(msg.content.parts)) {
            msg.content.parts.forEach((p) => {
              if (typeof p === "string" && p.trim()) parts.push(p);
            });
          }
        }
      }
    } else if (platformId === "claude") {
      // Claude: { chat_messages: [{ text: "", content: [{ text: "actual" }], sender: "human"|"assistant" }] }
      // 注意：text 常為空字串，實際內容在 content 陣列中
      const msgs = parsed.chat_messages || parsed.messages || [];
      if (Array.isArray(msgs)) {
        msgs.forEach((m) => {
          if (!m) return;
          if (Array.isArray(m.content)) {
            m.content.forEach((c) => {
              if (typeof c === "string" && c.trim()) parts.push(c);
              else if (c && typeof c.text === "string" && c.text.trim()) parts.push(c.text);
            });
          } else if (typeof m.text === "string" && m.text.trim()) {
            parts.push(m.text);
          } else if (typeof m.content === "string" && m.content.trim()) {
            parts.push(m.content);
          }
        });
      }
    } else if (platformId === "deepseek") {
      // DeepSeek: { data: { biz_data: { chat_messages: [{ role, content, fragments }] } } }
      const msgs =
        parsed.messages ||
        (parsed.data && parsed.data.messages) ||
        (parsed.data && parsed.data.biz_data && parsed.data.biz_data.chat_messages) ||
        [];
      if (Array.isArray(msgs)) {
        msgs.forEach((m) => {
          if (!m) return;
          // 嘗試從 content 欄位擷取
          if (typeof m.content === "string" && m.content.trim()) {
            parts.push(m.content);
          }
          // 嘗試從 fragments 陣列擷取
          if (Array.isArray(m.fragments)) {
            m.fragments.forEach((f) => {
              if (f && typeof f.content === "string" && f.content.trim()) {
                parts.push(f.content);
              }
            });
          }
        });
      }
    } else if (platformId === "grok") {
      // Grok: { responses: [{ responseId, message, sender: "human"|"ASSISTANT", ... }] }
      // message 是純文字（用戶輸入或助理回覆）
      const msgs = parsed.responses || [];
      if (Array.isArray(msgs)) {
        msgs.forEach((m) => {
          if (!m) return;
          if (typeof m.message === "string" && m.message.trim()) {
            parts.push(m.message);
          }
        });
      }
    } else if (platformId === "perplexity") {
      // Perplexity: { entries: [{ query_str, display_model, blocks: [{ markdown_block: { answer } }] }] }
      // query_str 是用戶輸入，blocks[].markdown_block.answer 是助理回覆
      // 注意：每個 entry 有兩個 markdown_block（ask_text_0_markdown 與 ask_text），內容相同，只取前者避免重複
      const entries = parsed.entries || [];
      if (Array.isArray(entries)) {
        entries.forEach((entry) => {
          if (!entry) return;
          if (typeof entry.query_str === "string" && entry.query_str.trim()) {
            parts.push(entry.query_str);
          }
          if (Array.isArray(entry.blocks)) {
            entry.blocks.forEach((block) => {
              if (
                block &&
                block.intended_usage === "ask_text_0_markdown" &&
                block.markdown_block &&
                typeof block.markdown_block.answer === "string" &&
                block.markdown_block.answer.trim()
              ) {
                parts.push(block.markdown_block.answer);
              }
            });
          }
        });
      }
    } else if (platformId === "qwen") {
      // Qwen: { data: { chat: { history: { messages: { id: { role, content, content_list, ... } } } } } }
      // messages 是物件，需用 Object.values 遍歷
      const msgs = parsed?.data?.chat?.history?.messages;
      if (msgs && typeof msgs === "object") {
        Object.values(msgs).forEach((m) => {
          if (!m) return;
          if (m.role === "user" && typeof m.content === "string" && m.content.trim()) {
            parts.push(m.content);
          } else if (m.role === "assistant") {
            // 優先取 content（若非空）
            if (typeof m.content === "string" && m.content.trim()) {
              parts.push(m.content);
            } else if (Array.isArray(m.content_list)) {
              // 組合 content_list 中所有非空 content
              const txt = m.content_list
                .map((c) => (c && typeof c.content === "string" ? c.content : ""))
                .filter((s) => s.trim())
                .join("\n");
              if (txt.trim()) parts.push(txt);
            }
          }
        });
      }
    }

    return parts.join("\n\n");
  }

  /** 從 Gemini batchexecute 回應中擷取對話文字。
   *  回應格式：)]}' 前綴 + chunked encoding（數字長度行 + JSON 資料行）
   *  hNvQHb RPC 的 inner JSON 結構（實機驗證）：
   *    inner = [ turns_array, null, null, metadata ]
   *    turns_array[0] = [ id_pair, null, userMsgs, asstResponses, timestamp ]
   *    userMsgs = [["user text"], 1, null, 0, ...]  （[0] 是用戶訊息陣列）
   *    asstResponses = [ [["rc_id", ["asst text"], ...]], [ref], null, "rc_id", ... ]
   *      （[0] 額外包一層陣列，內含 [rc_id, ["asst text"], ...]） */
  function extractGeminiHistoryText(body) {
    if (!body) return "";
    // 剝離 )]}' 前綴
    let text = body;
    if (text.startsWith(")]}'")) {
      text = text.slice(4);
    }
    // chunked encoding：每個 chunk 是獨立的 JSON，不能合併。只取第一個（含 hNvQHb 資料）。
    const lines = text.split(/\r?\n/);
    let parsed = null;
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (/^\d+$/.test(trimmed)) continue; // 跳過長度行
      try {
        parsed = JSON.parse(trimmed);
        break;
      } catch (_) {}
    }

    if (!parsed) return "";

    const parts = [];
    // 外層：[["wrb.fr","hNvQHb","<inner JSON string>",...]]
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (!Array.isArray(item) || item.length < 3) continue;
        if (item[0] !== "wrb.fr" || item[1] !== "hNvQHb") continue;
        const innerStr = item[2];
        if (typeof innerStr !== "string") continue;
        let inner;
        try {
          inner = JSON.parse(innerStr);
        } catch (_) {
          continue;
        }
        if (!Array.isArray(inner)) continue;

        // inner = [turns_array, null, null, metadata]
        // turns 在 inner[0]，需展開一層
        let turns = inner;
        if (
          inner.length >= 1 &&
          Array.isArray(inner[0]) &&
          inner[0].length >= 1 &&
          Array.isArray(inner[0][0])
        ) {
          turns = inner[0];
        }

        for (const turn of turns) {
          if (!Array.isArray(turn) || turn.length < 4) continue;

          // turn[2] = userMsgs: [["user text"], 1, null, ...]
          // [0] 是用戶訊息陣列 ["user text"]，其餘是 metadata
          const userMsgsArr = turn[2];
          if (Array.isArray(userMsgsArr)) {
            for (const u of userMsgsArr) {
              if (Array.isArray(u) && typeof u[0] === "string" && u[0].trim()) {
                parts.push(u[0]);
              }
            }
          }

          // turn[3] = asstResponses: [[["rc_id", ["asst text"], ...]], [ref], null, ...]
          // [0] 額外包一層陣列：[[rc_id, [text], ...]]
          const asstResponses = turn[3];
          if (Array.isArray(asstResponses)) {
            for (const r of asstResponses) {
              if (!Array.isArray(r)) continue;
              // 若 r 包一層（r[0] 是陣列），展開
              let candidate = r;
              if (r.length >= 1 && Array.isArray(r[0])) {
                candidate = r[0];
              }
              // candidate[1] = ["assistant text"]
              if (
                candidate.length >= 2 &&
                Array.isArray(candidate[1]) &&
                typeof candidate[1][0] === "string" &&
                candidate[1][0].trim()
              ) {
                parts.push(candidate[1][0]);
              }
            }
          }
        }
      }
    }

    return parts.join("\n\n");
  }

  // ---- 估算回退 ----
  async function runEstimate() {
    if (!state.platform) return;
    // 已有精準攔截值 → 不覆蓋（閒置時對話內容未變，精準值仍有效）
    // 只有初始狀態或對話切換（resetConversation 重置 state）才允許 DOM 估算
    if (state.source === "intercept" && state.used > 0)
      return;
    const text = AITC.platforms.scrapeConversationText(state.platform);
    if (!text) return;
    const { count } = await AITC.tokenizer.countTokens(
      text,
      state.platform.tokenizerFamily
    );
    if (state.source === "intercept" && state.used > 0) {
      diagLog("estimate-skipped", { count, used: state.used, lastInterceptTs: state.lastInterceptTs });
      return; // 估算期間又收到攔截值，捨棄
    }
    diagLog("estimate-applied", { count, oldUsed: state.used, lastInterceptTs: state.lastInterceptTs });
    state.used = count;
    state.inputTokens = null;
    state.outputTokens = null;
    state.source = "estimate";
    render();
    reportToBackground();
  }

  /** SSE 完成但無 usage（Claude web）→ 重設攔截時間戳並立即估算。
   *  延遲 600ms 等待 DOM 渲染助理回覆。
   *  若已有 request-body 攔截的 input_tokens，僅更新 output_tokens（最新助理回覆）。
   *  若 request-body 尚未到達（handleRequestBody 未完成），設定 pendingOutputUpdate 旗標，
   *  等 handleRequestBody 完成後自動更新 output_tokens。 */
  function triggerEstimateAfterResponse() {
    setTimeout(() => {
      if (state.source === "intercept" && state.inputTokens != null) {
        // 已有 request-body 攔截的精準 input_tokens，僅更新 output_tokens
        updateOutputTokensWithRetry(0);
      } else if (state.lastInterceptTs === 0 && state.used === 0) {
        // 無攔截值，允許立即 DOM 估算
        runEstimate();
      } else {
        // request-body 可能尚在處理中，設定旗標等待 handleRequestBody 完成後更新
        state.pendingOutputUpdate = true;
        // 同時啟動重試，以防 handleRequestBody 失敗
        setTimeout(() => {
          if (state.pendingOutputUpdate && state.source === "intercept" && state.inputTokens != null) {
            state.pendingOutputUpdate = false;
            updateOutputTokensWithRetry(0);
          }
        }, 2000);
      }
    }, 600);
  }

  /** 僅更新 output_tokens（最新助理回覆的 token 數）。
   *  在已有 request-body 攔截 input_tokens 的情況下使用。
   *  助理回覆可能延遲渲染，加入重試機制（最多 5 次，每次間隔 800ms）。 */
  async function updateOutputTokensWithRetry(attempt) {
    if (!state.platform) return;
    const latestOutput = AITC.platforms.scrapeLatestAssistantText(state.platform);
    if (!latestOutput) {
      // 助理回覆尚未渲染，重試
      if (attempt < 5) {
        setTimeout(() => updateOutputTokensWithRetry(attempt + 1), 800);
      }
      return;
    }
    const { count } = await AITC.tokenizer.countTokens(
      latestOutput,
      state.platform.tokenizerFamily
    );
    state.outputTokens = count;
    state.used = (state.inputTokens || 0) + count;
    render();
    reportToBackground();
  }

  function startEstimateTimer() {
    if (estimateTimer) return;
    estimateTimer = setInterval(runEstimate, 10000);
  }

  // ---- 對話邊界偵測（URL 變化）----
  let lastUrl = location.href;
  function watchUrlChange() {
    setInterval(() => {
      if (location.href === lastUrl) return;
      lastUrl = location.href;
      const newId = AITC.platforms.getConversationId(state.platform);
      if (newId !== state.conversationId) {
        // 若最近有攔截（如 Gemini 發送訊息時建立新對話導致 URL 變更），
        // 僅更新對話 ID 不重置計數，避免遺失精準攔截值
        if (Date.now() - state.lastInterceptTs < 5000) {
          state.conversationId = newId;
        } else {
          resetConversation(newId);
        }
      }
    }, 1000);
  }

  // ---- 診斷：輸出到 console.debug（供開發者從 devtools 查看）----
  function diagLog(type, info) {
    try {
      console.debug("[AITC]", type, info || {});
    } catch (_) {}
  }

  // ---- 訊息來源監聽（來自 inject.js MAIN 世界）----
  window.addEventListener("message", (ev) => {
    if (ev.source !== window) return;
    const data = ev.data;
    if (!data || data.source !== "aitc-inject") return;
    diagLog("msg-recv", { msgType: data.type, hasUsage: !!data.usage, usage: data.usage, bodyLen: data.bodyText ? data.bodyText.length : 0 });
    if (data.type === "usage") {
      handleInterceptedUsage(data);
      diagLog("after-usage", { used: state.used, input: state.inputTokens, output: state.outputTokens, source: state.source });
    } else if (data.type === "request-body") {
      handleRequestBody(data);
      diagLog("after-request-body", { used: state.used, input: state.inputTokens, output: state.outputTokens, source: state.source });
    } else if (data.type === "history-body") {
      handleHistoryBody(data);
      diagLog("after-history-body", { used: state.used, input: state.inputTokens, output: state.outputTokens, source: state.source });
    } else if (data.type === "response-complete") {
      // SSE 完成但無 usage（Claude web 不帶 usage）→ 立即觸發 DOM 估算
      if (data.conversationId && data.conversationId !== state.conversationId) {
        resetConversation(data.conversationId);
      }
      triggerEstimateAfterResponse();
    }
  });

  // ---- 來自 background 的指令（如 popup 重置）----
  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      if (msg.type === "reset-current") {
        resetConversation(state.conversationId);
        sendResponse && sendResponse({ ok: true });
      } else if (msg.type === "get-status") {
        sendResponse &&
          sendResponse({
            platformId: state.platform ? state.platform.id : null,
            platformLabel: state.platform ? state.platform.label : null,
            conversationId: state.conversationId,
            contextWindow: state.contextWindow,
            used: state.used,
            inputTokens: state.inputTokens,
            outputTokens: state.outputTokens,
            source: state.source,
          });
      }
      return true;
    });
  } catch (_) {}

  // ---- 啟動 ----
  (async function init() {
    settings = await AITC.storage.getSettings();
    state.platform = AITC.platforms.detectPlatform();
    if (!state.platform) return;
    if (settings.enabled === false) return;
    if (
      settings.platforms &&
      settings.platforms[state.platform.id] === false
    )
      return;

    state.conversationId = AITC.platforms.getConversationId(state.platform);
    state.contextWindow = state.platform.defaultContextWindow;

    // 載入速率限制設定與事件歷史
    try {
      rlState.settings = await AITC.storage.getRateLimitSettings();
      await refreshRateLimit();
    } catch (_) {}

    await AITC.ui.mount();
    render();
    reportToBackground();

    startEstimateTimer();
    watchUrlChange();
    startRateLimitTimer();

    // 初次延遲估算一次（頁面剛載入若有歷史對話）
    setTimeout(runEstimate, 2500);
  })();

  /** 定時刷新速率限制狀態（每 30 秒，更新重置時間與預測） */
  function startRateLimitTimer() {
    if (rateLimitTimer) return;
    rateLimitTimer = setInterval(refreshRateLimit, 30000);
  }
})();
