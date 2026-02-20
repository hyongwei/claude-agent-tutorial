# 心理諮詢 AI Agent — 學習用 Prototype

以 Claude API 打造的心理諮詢聊天機器人，展示如何用 **AI Agent 架構**開發具備記憶、工具呼叫與技能切換的對話式應用。

## 功能展示

- **多輪對話** — 透過短期記憶（Session）保持對話連貫性
- **長期記憶** — Claude 自主讀寫 XML 檔案，跨 Session 記住用戶資訊
- **心情覺察牌卡** — 視覺化牌卡選擇介面，協助用戶覺察情緒
- **冥想引導** — 呼吸動畫元件，帶有倒數計時與階段引導
- **Skills 架構** — 技能協議存放於獨立 SKILL.md 檔案，按需動態載入
- **即時串流** — SSE（Server-Sent Events）讓回覆逐字出現

## 技術架構

```
前端                      後端                       AI
─────────────────         ──────────────────         ──────────────────
React + TypeScript    →   Express + TypeScript   →   Claude API
Tailwind CSS              SSE 串流                   toolRunner（Agent 迴圈）
Vite                      短期記憶（Map）             Memory Tool（長期記憶）
                          server/skills/             Skills（SKILL.md）
```

**主要套件**

| 套件 | 用途 |
|------|------|
| `@anthropic-ai/sdk` | Claude API 呼叫、toolRunner、Memory Tool |
| `express` | HTTP server + SSE 端點 |
| `react` + `vite` | 前端 UI |
| `tailwindcss` | 樣式 |
| `tsx` | 直接執行 TypeScript server |
| `concurrently` | 同時啟動前後端 |

## 專案結構

```
claude-agent-tutorial/
├── server/
│   ├── index.ts          # Express server，SSE 端點 /api/chat
│   ├── counselor.ts      # Agent 核心：記憶、工具、toolRunner
│   ├── memories/         # 長期記憶檔案（git ignored，由 Claude 自動建立）
│   │   └── user_profile.xml
│   └── skills/           # 技能協議（SKILL.md）
│       ├── mood-awareness-cards/SKILL.md
│       └── meditation-guide/SKILL.md
└── src/
    └── App.tsx            # 聊天 UI、SSE 讀取、各 UI 元件
```

## 快速開始

### 1. 安裝依賴

```bash
npm install
```

### 2. 設定 API Key

建立 `.env` 檔案：

```
ANTHROPIC_API_KEY=sk-ant-...
```

### 3. 啟動開發伺服器

```bash
npm run dev:all
```

開啟 http://localhost:5173

## 核心概念說明

### Agent 迴圈（toolRunner）

這是整個應用最核心的部分。`toolRunner` 讓 Claude 可以自主決定是否呼叫工具，並在工具結果回傳後繼續生成回覆，形成一個自動的 Agent 迴圈：

```
Claude 回覆
  ↓ 需要工具？
  ├── 是 → 自動執行工具 → 結果送回 Claude → 繼續回覆（下一輪）
  └── 否 → 結束，輸出最終文字
```

```typescript
// server/counselor.ts
const runner = anthropic.beta.messages.toolRunner({
  model: 'claude-haiku-4-5-20251001',
  tools: [memoryTool, readSkillTool, createMoodCardsTool(onCards), createMeditationTool(onMeditation)],
  stream: true,
  max_iterations: 10,
  messages,
})
```

### Skills 架構

System Prompt 只放技能的 metadata（名稱、一句話描述、啟動時機），完整協議放在 SKILL.md，由 `read_skill` 工具動態載入：

```
System Prompt（永遠載入，~30 tokens/技能）
  │  mood-awareness-cards | 心情覺察牌卡 | 情緒難以言語化時...
  │  meditation-guide     | 冥想引導     | 用戶說太緊張時...
  ↓
read_skill("meditation-guide")  ← Claude 判斷需要時呼叫
  ↓
載入 server/skills/meditation-guide/SKILL.md（完整協議 ~600 tokens）
  ↓
Claude 按協議執行，呼叫 show_meditation UI 工具
```

### UI 工具與 SSE 資料流

UI 工具透過 Closure 把 callback 包在工具裡，Claude 呼叫工具即觸發前端渲染：

```
Claude 呼叫 show_meditation(title, guidance, breathing, ...)
  → onMeditation(event)         # closure callback
  → sendEvent('meditation', event)  # SSE
  → setPendingMeditation(data)  # React state
  → <MeditationGuide> 元件渲染
```

### 記憶系統

| 類型 | 實作方式 | 生命週期 |
|------|---------|---------|
| 短期記憶 | `Map<sessionId, Message[]>` | Server 重啟後消失 |
| 長期記憶 | Claude 讀寫 `server/memories/*.xml` | 永久保存 |

## 新增技能

1. 建立 `server/skills/<skill-name>/SKILL.md`
2. 在 `counselor.ts` 的 Skills Registry 表格新增一行
3. 在 `readSkillTool` 的 `enum` 新增技能名稱
4. 如需 UI 元件：新增工具工廠函數 + SSE 事件 + React 元件

## 注意事項

- 此為學習用 Prototype，不應用於真實的心理諮商場景
- 若有緊急心理危機，請撥打台灣自殺防治專線 **1925**
- API Key 請妥善保管，勿提交至版本控制
