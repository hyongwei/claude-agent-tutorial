# Checkpoint — 心理諮詢 AI Agent Prototype

> 最後更新：2026-02-20

---

## 目前完成進度

### 第一階段：專案基礎建設

- [x] 用 Vite 建立 React + TypeScript 前端專案
- [x] 建立 Express + TypeScript 後端伺服器
- [x] 設定 `concurrently` 同時啟動前後端（`npm run dev:all`）
- [x] 設定 Vite Proxy，讓前端 `/api/` 請求自動轉發到後端
- [x] 用 Tailwind CSS 建立聊天介面（訊息泡泡、輸入框、標題列）
- [x] SSE（Server-Sent Events）串流實作，讓回覆逐字出現

### 第二階段：AI Agent 核心

- [x] 串接 Anthropic SDK（`@anthropic-ai/sdk`）
- [x] 用 `toolRunner` 實作 Agent 迴圈（自動處理工具呼叫 → 回覆 → 再呼叫）
- [x] **短期記憶**：用 `Map<sessionId, Message[]>` 保存對話歷史，讓 Claude 記得上下文
- [x] **長期記憶**：用 `betaMemoryTool` + `FileSystemMemoryHandlers` 讓 Claude 自主讀寫 XML 記憶檔案，跨 Session 記住用戶資訊
- [x] 建立心理諮詢 System Prompt（CBT 方法論、記憶使用指示、危機處理、文化敏感度）
- [x] Session ID 用 `localStorage` 持久化，瀏覽器重整不會重置

### 第三階段：Skills 架構

- [x] **心情覺察牌卡技能**：8 種色彩主題牌卡，視覺化情緒選擇 UI
- [x] 將技能協議從 System Prompt 分離，改為獨立 `SKILL.md` 檔案
- [x] 實作 `read_skill` 工具：Claude 按需動態載入技能協議（Skills 架構核心）
- [x] **冥想引導技能**：呼吸動畫元件（`transform: scale` + CSS transition）、倒數計時、階段引導（吸氣／屏氣／呼氣／休息）
- [x] UI 工具用 Closure 模式設計：Claude 呼叫工具 → callback → SSE → React 渲染

### 第四階段：品質與維護

- [x] 修復卡牌選擇後對話重置 Bug（原因：內層 catch 吞掉 error、button 缺少 `type="button"`）
- [x] 加入 `activeStreamId` ref 防止舊串流汙染新對話
- [x] 將模型換成 `claude-haiku-4-5-20251001` 降低 Token 費用
- [x] 建立 GitHub Repository，完整版本控制
- [x] 設定 `.gitignore`（排除 `.env`、`server/memories/`）
- [x] 撰寫 README（架構說明、快速開始、核心概念）
- [x] 建立 `.env.example`

---

## 學習過程重點紀錄

### 核心概念理解

| 概念 | 學到了什麼 |
|------|-----------|
| **AI Agent 迴圈** | 不是一問一答，而是 Claude 自主決定呼叫工具、等待結果、再繼續回覆的循環 |
| **無狀態 API** | Claude 本身不記得任何事，「記憶」是我們把對話歷史每次重新送過去 |
| **SSE vs WebSocket** | SSE 是單向（Server → Client），適合 AI 串流；WebSocket 雙向，適合即時聊天室 |
| **Skills 架構** | System Prompt 只放 metadata（輕），完整協議放 SKILL.md 按需載入（重） |
| **Closure 模式** | UI 工具透過 closure 包住 callback，讓工具執行可以觸發 React 狀態更新 |
| **BFF 模式** | 為特定前端設計的後端聚合層，目前 Express server 已扮演此角色 |

### 技術實作關鍵點

```
短期記憶：Map（記憶體）→ 重啟消失
長期記憶：XML 檔案（磁碟）→ 永久保存，但 Claude 自主管理

工具分工：
  memoryTool   → 讀寫長期記憶（知識工具）
  read_skill   → 動態載入 SKILL.md（知識工具）
  show_*       → 觸發前端 UI（UI 工具）
```

---

## 後續可優化與學習的方向

### 功能強化

- [ ] **Markdown 渲染**：Claude 回覆常包含 `**粗體**`、清單等格式，目前純文字顯示，可加入 `react-markdown`
- [ ] **對話歷史側邊欄**：列出過去的 Session，可切換查看
- [ ] **更多 Skills**：例如認知重構練習（CBT 思維記錄表）、漸進式肌肉放鬆引導、情緒日記
- [ ] **打字中指示器細化**：目前只有「三個點」，可區分「Claude 在思考」vs「Claude 在呼叫工具（載入技能中...）」

### 架構演進

- [ ] **用戶認證**：目前所有用戶共用同一個 Express server，加入登入機制才能區分不同用戶的記憶
- [ ] **資料庫取代 XML**：目前長期記憶存在 XML 檔，換成 SQLite 或 PostgreSQL 更適合多用戶場景
- [ ] **記憶壓縮**：長期記憶隨使用增長，可讓 Claude 定期摘要整合，避免檔案過大
- [ ] **速率限制（Rate Limiting）**：防止單一用戶發送大量請求
- [ ] **串流中斷處理**：用戶關閉瀏覽器時，後端應能偵測並中止 Claude API 呼叫節省費用

### 部署與生產化

- [ ] **部署到雲端**：Railway / Render / Fly.io 適合這類全端 Node.js 應用
- [ ] **環境分離**：開發、測試、生產環境的設定分開管理
- [ ] **錯誤監控**：加入 Sentry 或類似工具，線上問題能即時發現
- [ ] **API Key 輪換機制**：Key 外洩時可快速切換

### 深入學習建議

- [ ] **Claude Agent SDK**（`@anthropic-ai/claude-agent-sdk`）：目前用原始 SDK 手刻，官方 Agent SDK 提供更高層抽象，值得研究差異
- [ ] **Multi-Agent**：目前是單一 Agent，可探索讓多個 Claude 實例分工（例如一個負責諮詢、一個負責記憶管理）
- [ ] **Evaluation（評估）**：如何衡量 AI 諮詢回覆的品質？建立評估框架是 AI 產品化的重要課題
- [ ] **Prompt Engineering 進階**：Few-shot prompting、Chain-of-Thought 在諮詢場景的應用

---

## 目前已知限制

| 限制 | 說明 |
|------|------|
| 單用戶設計 | 記憶檔案存在本地，無法多用戶共用 |
| Server 重啟短期記憶消失 | Map 在記憶體中，重啟後對話歷史歸零 |
| 無身份驗證 | 任何人知道 localhost:3001 都能存取 |
| Token 費用隨使用累積 | 長對話歷史會讓每次 API 呼叫的費用上升 |

---

## 快速重啟開發

```bash
git clone https://github.com/hyongwei/claude-agent-tutorial.git
cd claude-agent-tutorial
npm install
cp .env.example .env   # 填入 ANTHROPIC_API_KEY
npm run dev:all         # 開啟 http://localhost:5173
```
