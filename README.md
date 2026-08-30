# AI 對話 Token 計數器

> 即時顯示 7 大 AI 平台對話的 Token 消耗、Context Window 使用率與**速率限制預警**的 Chrome 擴充功能。

支援 **Claude、ChatGPT、Gemini、DeepSeek、Grok、Perplexity、Qwen** 七個主流 AI 平台，让你在對話過程中隨時掌握 Token 用量與「即將被速率限制」的風險，避免對話到一半被迫中斷數小時。

---

## 目錄

- [核心功能](#核心功能)
- [與其他 Token Counter 擴充功能的差異](#與其他-token-counter-擴充功能的差異)
- [安裝方式](#安裝方式)
- [使用說明](#使用說明)
- [設定選項](#設定選項)
- [架構與技術細節](#架構與技術細節)
- [支援平台](#支援平台)
- [免責聲明](#免責聲明)

---

## 核心功能

### 1. 即時 Token 計數（雙模式）

- **精準模式（攔截）**：透過攔截 AI 平台實際發送的 API 請求與回應，取得最真實的 Token 用量。支援從 request body 抓取完整對話歷史（含系統提示、工具定義），用 WASM tokenizer 精確計算 input_tokens。
- **估算模式（fallback）**：當攔截失敗或平台不暴露 API 時，自動退化為 DOM 抓取 + WASM tokenizer 估算。
- 模式會以顏色徽章清楚標示（精準=淺綠、估算=淺黃）。

### 2. Context Window 使用率視覺化

- 收合模式：圓形進度條（內圈）即時顯示當前對話佔用模型 Context Window 的百分比。
- 展開模式：水平進度條 + 詳細數據（已用 / 上限 / 剩餘 / 百分比）。
- 三段配色警示：低使用率（深藍）→ 警告（黃）→ 臨界（紅）。

### 3. ⚡ 速率限制預警（B+C 智慧方案）

這是與其他類似擴充功能最大的差異：

- **內建 7 平台速率限制預設值**：依各平台官方/社群觀測值設定不同方案的訊息數上限與時間窗口（如 Claude 免費版 8 小時 30 則、ChatGPT 3 小時 40 則）。
- **方案標記（免費/付費）**：可在 options 頁切換各平台方案，預設值自動切換。
- **滾動窗口計算**：即時計算當前時間窗口內已發送訊息數與累積 Token 數。
- **消耗速率預測**：根據歷史速率推算「預計何時觸發限制」（ETA）。
- **雙進度條視覺**：
  - 收合模式：外圈顯示速率限制使用率（與內圈上下文同色，接近限制才變黃/紅）。
  - 展開模式：上方獨立區塊顯示「已用 X/Y 則」、預估剩餘訊息數、觸發時間、重置時間。

### 4. 精緻的浮窗 UI

- **Shadow DOM 隔離**：不影響原網頁樣式，也不被網頁 CSS 污染。
- **雙主題自動切換**：依頁面背景亮度自動切換深色/淺色模式。
- **Morph 方向性動畫**：展開時先向下再往右、收合時先向左再向上，過程保持圓角長方形，收合完成才變圓形。
- **可拖曳**：收合模式圓球可拖曳至螢幕任意位置。
- **回應式**：視窗寬度 < 1000px 或高度 < 700px 時自動進入 compact 模式。
- **黑／白模式切換**：設定頁可選「自動/深色/淺色」，popup 工具列有太陽／月亮滑動開關一鍵切換。
- **平台原生 Logo**：使用 lobehub/icons 的 SVG，配合品牌色呈現，設定頁清單亦顯示各廠商 Logo。

---

## 與其他 Token Counter 擴充功能的差異

| 特色 | 本擴充功能 | 一般同類擴充 |
|---|---|---|
| **支援平台數** | 7 個主流平台 | 多為 1-3 個 |
| **Token 計數來源** | 攔截 API + DOM 估算雙模式 | 多為純 DOM 估算 |
| **攔截精準度** | 直接解析 request body 與 history response，含系統提示與工具定義 | 通常只看 DOM 可見文字 |
| **速率限制預警** | ✅ 內建 7 平台預設值、可調整、可標記免費/付費版、門檻通知 | ❌ 多數完全沒有 |
| **觸發時間預測** | ✅ 依消耗速率推算 ETA | ❌ |
| **Context Window 顯示** | ✅ 依各模型實際上下文長度 | 部分有，但常固定值 |
| **可拖曳** | ✅ 收合模式可拖至任意位置 | ❌ 多為固定位置 |
| **自適應主題** | ✅ 依頁面背景自動切換深/淺色 | 多為單一主題 |
| **完全離線** | ✅ 不呼叫任何外部 API | 部分會回傳資料到伺服器 |
| **開源** | ✅ 可自行審計、修改 | 多為閉源 |

**簡言之：本擴充不只是「計數器」，而是「Token 與速率限制的雙重守門員」。**

---

## 安裝方式

### 開發者載入（未發布至 Chrome Web Store 前）

1. 下載或 clone 本專案：
   ```bash
   git clone https://github.com/你的帳號/ai-token-counter.git
   ```
2. 打開 Chrome，進入 `chrome://extensions/`
3. 右上角開啟「開發人員模式」
4. 點「載入未封裝項目」，選擇專案根目錄
5. 擴充功能即出現在列表中，造訪任一支援的 AI 平台即可看到浮窗

> **注意**：本擴充功能需要 `lib/tiktoken.wasm` 檔案（OpenAI tiktoken 的 WASM 版本）才能執行精確 Token 計數。若專案中缺少此檔案，請參考 [tiktoken-wasm](https://github.com/djc/tiktoken-wasm) 自行建置並放入 `lib/` 目錄。

---

## 使用說明

### 基本操作

1. **造訪任一支援的 AI 平台**（如 claude.ai、chatgpt.com）
2. 螢幕右下角會出現一個圓形浮窗（含平台 logo 與雙圈進度條）
3. **點擊浮窗**：展開為詳細模式，顯示完整數據
4. **再次點擊右上角 ×**：收合為圓形
5. **拖曳收合浮窗**：移動到喜歡的位置（點擊與拖曳以 4px threshold 區分）

### 顯示資訊

#### 收合模式（80×80 圓形）
- 內圈圓環：Context Window 使用率（顏色依使用率變化）
- 外圈圓環：速率限制使用率
- 中央 logo：當前平台圖示
- 緊湊模式下額外顯示：右上角模式圓點、底部百分比

#### 展開模式（280×215）
- **頂部**：平台名稱 + 模式徽章（精準/估算）+ 收合鈕
- **速率限制區塊**（上方）：
  - 「速率限制 — 已用 X/Y 則」
  - 進度條（顏色依使用率）
  - 預估剩餘訊息數、觸發時間、重置時間
- **Context Window 區塊**（下方）：
  - 「上下文 — 已用 X / 上限 Y」
  - 進度條
  - input/output 分項、剩餘空間、百分比

---

## 設定選項

點擊擴充功能圖示 → 「擴充功能選項」，或於 `chrome://extensions/` 點選「資訊」→「擴充功能選項」。

### 可調整項目

1. **啟用/停用整個擴充功能**
2. **各平台啟停**：可單獨關閉某個平台（如只用 Claude 就關閉其他 6 個）
3. **主題模式**：自動（偵測頁面/系統）/ 深色 / 淺色
4. **顯示來源徽章**：是否顯示「精準/估算」標籤
5. **速率限制設定**：
   - 每個平台可選方案（免費/付費）
   - 可自訂時間窗口（小時）與訊息數上限
   - 訊息數設為 0 = 無限制
   - 「重置為預設值」按鈕
   - 「清除速率限制歷史」按鈕

### 預設速率限制（僅供參考，會隨平台政策變動）

| 平台 | 免費版窗口 | 免費版訊息 | 付費版窗口 | 付費版訊息 |
|---|---|---|---|---|
| Claude | 8 小時 | 30 則 | 5 小時 | 100 則 |
| ChatGPT | 3 小時 | 40 則 | 3 小時 | 80 則 |
| Gemini | 24 小時 | 1500 則 | 24 小時 | 無限制 |
| DeepSeek | 24 小時 | 50 則 | 24 小時 | 500 則 |
| Grok | 1 小時 | 13 則 | 1 小時 | 無限制 |
| Perplexity | 4 小時 | 50 則 | 4 小時 | 300 則 |
| Qwen | 24 小時 | 50 則 | 24 小時 | 無限制 |

> 這些是社群觀測值，實際限制可能因地區、帳號年齡、政策更新而不同。建議依自身情況在 options 頁微調。

---

## 支援平台

| 平台 | 網址 | 偵測方式 |
|---|---|---|
| Claude | claude.ai | 攔截 history response + request body |
| ChatGPT | chatgpt.com | 攔截 mapping 歷史 + request body |
| Gemini | gemini.google.com | 攔截 batchexecute 回應 |
| DeepSeek | chat.deepseek.com | 攔截 accumulated_token_usage + DOM fallback |
| Grok | grok.com | DOM 抓取 + DOM 估算 |
| Perplexity | perplexity.ai | 攔截對話歷史 API |
| Qwen | chat.qwen.ai | 攔截對話歷史 API |

---

## 架構與技術細節

### Manifest V3 雙世界內容腳本

- **MAIN 世界**（`content/inject.js`）：`document_start` 注入，攔截 `fetch` 與 `XMLHttpRequest`，將 usage 與 request body 透過 `CustomEvent` 傳遞給 ISOLATED 世界。
- **ISOLATED 世界**（`content/index.js` + `lib/*`）：`document_idle` 注入，可存取 `chrome.runtime` API。協調平台偵測、Token 計數、UI 渲染、速率限制追蹤。

### 模組結構

```
Token_Counter/
├── manifest.json          # MV3 設定
├── background.js          # Service Worker（通知、設定初始化）
├── content/
│   ├── inject.js          # MAIN 世界攔截器
│   ├── index.js           # ISOLATED 世界協調者
│   └── styles.css         # 浮窗容器樣式
├── lib/
│   ├── platforms.js       # 7 平台偵測與 DOM 抓取
│   ├── storage.js         # chrome.storage 封裝
│   ├── rateLimit.js       # 速率限制預設值與計算
│   ├── tokenizer.js       # WASM tokenizer 封裝
│   ├── ui.js              # Shadow DOM 浮窗 UI
│   └── tiktoken.wasm      # OpenAI tiktoken WASM（需另建置）
├── popup/                 # 工具列圖示彈窗
├── options/               # 設定頁
└── assets/icons/          # 平台 SVG 與擴充功能圖示
```

### 資料儲存

- `chrome.storage.sync`：使用者設定、速率限制設定
- `chrome.storage.local`：速率限制事件時間序列（key: `rl-events:{platformId}`，保留 7 天）

### 隱私

- **不收集任何資料**：所有 Token 計算與速率限制追蹤都在使用者瀏覽器本地進行。
- **不呼叫外部伺服器**：除了各 AI 平台本身與 `chrome.runtime.getURL()` 載入擴充功能內資源外，不發送任何資料到第三方。
- **可隨時清除**：options 頁提供「清除速率限制歷史」按鈕。

---

## 開發與貢獻

### 開發環境需求

- Node.js（僅用於語法檢查 `node --check`）
- Chrome 瀏覽器（開發者模式）

### 語法檢查

```bash
node --check lib/rateLimit.js
node --check lib/storage.js
node --check lib/ui.js
node --check content/index.js
node --check background.js
node --check options/options.js
```

### 貢獻方式

歡迎提交 Issue 或 Pull Request：
- 回報平台偵測失誤
- 更新速率限制預設值（平台政策變動時）
- 新增平台支援
- 改善 Token 計數精度

---

## 免責聲明

- 本擴充功能**不以任何方式與各 AI 平台關聯**，所有商標屬原公司所有。
- 速率限制預設值為**社群觀測值**，可能隨平台政策變動而失效，請以各平台官方說明為準。
- Token 計數精度受限於平台揭露的資訊，估算模式可能與實際有出入。
- 使用本擴充功能需遵守各 AI 平台的服務條款。

---

## 授權

MIT License - 詳見 [LICENSE](LICENSE) 檔案。
