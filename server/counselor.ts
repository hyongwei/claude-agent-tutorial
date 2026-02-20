/**
 * counselor.ts — 心理諮詢 AI Agent 核心邏輯
 *
 * 這個檔案負責：
 * 1. 短期記憶：用 Map 儲存每個 session 的對話歷史（server 重啟後消失）
 * 2. 長期記憶：用 Claude Memory Tool + 檔案系統持久化重要資訊
 * 3. 呼叫 Claude API：用 toolRunner 自動管理多輪工具呼叫
 * 4. 串流回應：把 Claude 的回覆即時傳給前端
 */

import 'dotenv/config'
import Anthropic from '@anthropic-ai/sdk'
import {
  betaMemoryTool,
  type MemoryToolHandlers,
} from '@anthropic-ai/sdk/helpers/beta/memory.js'
import * as fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import * as path from 'node:path'

// ─────────────────────────────────────────────────────────────────────────────
// 短期記憶（Short-term Memory）
//
// 原理：Claude API 是「無狀態」的 — 每次 API 呼叫都是全新的對話。
// 要讓 Claude「記得」之前說了什麼，我們必須把整段對話歷史一起傳送。
// 這裡用一個 Map 來儲存每個 sessionId 的對話歷史。
// ─────────────────────────────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant'

export interface ShortTermMessage {
  role: MessageRole
  content: string
}

// 模組層級的 Map：只要 server 不重啟，資料就會一直存在
// key = sessionId（前端存在 localStorage 的 UUID）
// value = 對話陣列
const sessions = new Map<string, ShortTermMessage[]>()

export function getSession(sessionId: string): ShortTermMessage[] {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, [])
  }
  return sessions.get(sessionId)!
}

export function addToSession(
  sessionId: string,
  role: MessageRole,
  content: string
): void {
  const msgs = getSession(sessionId)
  msgs.push({ role, content })
  // 保留最近 50 則，避免 token 爆炸
  if (msgs.length > 50) {
    msgs.splice(0, msgs.length - 50)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 長期記憶（Long-term Memory）— FileSystemMemoryHandlers
//
// 原理：Claude 的 Memory Tool 讓 Claude 可以呼叫 6 個「指令」來操作檔案：
//   view   — 列出目錄或讀取檔案
//   create — 建立新檔案
//   str_replace — 取代檔案中的文字（精確替換）
//   insert — 在指定行號後插入文字
//   delete — 刪除檔案或目錄
//   rename — 重新命名
//
// 我們要實作 MemoryToolHandlers 介面，告訴 SDK 如何執行這些操作。
// betaMemoryTool() 會把這個實作包裝成 Claude 可以理解的工具定義。
// ─────────────────────────────────────────────────────────────────────────────

// 記憶檔案存放位置
const MEMORY_ROOT = path.resolve('./server/memories')

class FileSystemMemoryHandlers implements MemoryToolHandlers {
  // 啟動時呼叫，確保目錄存在
  static async init() {
    await fs.mkdir(MEMORY_ROOT, { recursive: true })
    console.log(`[Memory] 記憶目錄就緒: ${MEMORY_ROOT}`)
  }

  // 安全性：防止路徑穿越攻擊（path traversal）
  // 例如防止 Claude 嘗試讀取 /memories/../../../etc/passwd
  private resolveSafePath(memPath: string): string {
    if (!memPath.startsWith('/memories')) {
      throw new Error(`路徑必須以 /memories 開頭，收到: ${memPath}`)
    }
    const relative = memPath.slice('/memories'.length).replace(/^[/\\]/, '')
    const full = relative ? path.join(MEMORY_ROOT, relative) : MEMORY_ROOT
    const resolved = path.resolve(full)
    const resolvedRoot = path.resolve(MEMORY_ROOT)
    if (
      !resolved.startsWith(resolvedRoot + path.sep) &&
      resolved !== resolvedRoot
    ) {
      throw new Error(`偵測到路徑穿越攻擊: ${memPath}`)
    }
    return resolved
  }

  // VIEW：列出目錄內容 或 讀取檔案（可指定行範圍）
  async view(command: Parameters<MemoryToolHandlers['view']>[0]): Promise<string> {
    const fullPath = this.resolveSafePath(command.path)
    try {
      const stat = await fs.stat(fullPath)
      if (stat.isDirectory()) {
        return await this.buildDirectoryListing(fullPath, command.path)
      } else {
        const content = await fs.readFile(fullPath, 'utf-8')
        const lines = content.split('\n')
        const start = command.view_range?.[0] ?? 1
        const end =
          command.view_range?.[1] === -1
            ? lines.length
            : (command.view_range?.[1] ?? lines.length)
        return lines
          .slice(start - 1, end)
          .map((line, i) => `${String(start + i).padStart(6)}\t${line}`)
          .join('\n')
      }
    } catch {
      return `路徑 ${command.path} 不存在。`
    }
  }

  // 輔助：建立目錄樹狀列表
  private async buildDirectoryListing(
    dirPath: string,
    logicalPath: string
  ): Promise<string> {
    const lines = [
      `${logicalPath} 目錄內容（最多 2 層）：`,
    ]
    const walk = async (current: string, logical: string, depth: number) => {
      const entries = await fs.readdir(current, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue
        const childFull = path.join(current, entry.name)
        const childLogical = `${logical}/${entry.name}`
        const stat = await fs.stat(childFull)
        const sizeKb = (stat.size / 1024).toFixed(1) + 'K'
        lines.push(`${sizeKb}\t${childLogical}`)
        if (entry.isDirectory() && depth < 2) {
          await walk(childFull, childLogical, depth + 1)
        }
      }
    }
    await walk(dirPath, logicalPath, 1)
    return lines.join('\n')
  }

  // CREATE：建立新檔案（檔案已存在則報錯）
  async create(command: Parameters<MemoryToolHandlers['create']>[0]): Promise<string> {
    const fullPath = this.resolveSafePath(command.path)
    if (existsSync(fullPath)) {
      return `錯誤：檔案 ${command.path} 已存在`
    }
    await fs.mkdir(path.dirname(fullPath), { recursive: true })
    await fs.writeFile(fullPath, command.file_text, 'utf-8')
    return `檔案建立成功：${command.path}`
  }

  // STR_REPLACE：精確找到字串並取代（必須唯一，否則拒絕）
  async str_replace(command: Parameters<MemoryToolHandlers['str_replace']>[0]): Promise<string> {
    const fullPath = this.resolveSafePath(command.path)
    let content: string
    try {
      content = await fs.readFile(fullPath, 'utf-8')
    } catch {
      return `錯誤：找不到 ${command.path}`
    }
    const count = content.split(command.old_str).length - 1
    if (count === 0) {
      return `取代失敗：在 ${command.path} 中找不到 \`${command.old_str}\``
    }
    if (count > 1) {
      return `取代失敗：\`${command.old_str}\` 在 ${command.path} 中出現 ${count} 次，請確保目標字串唯一`
    }
    const newContent = content.replace(command.old_str, command.new_str)
    await fs.writeFile(fullPath, newContent, 'utf-8')
    return `記憶檔案已更新：${command.path}`
  }

  // INSERT：在指定行號後插入文字（行號 0 = 檔案最前面）
  async insert(command: Parameters<MemoryToolHandlers['insert']>[0]): Promise<string> {
    const fullPath = this.resolveSafePath(command.path)
    let content: string
    try {
      content = await fs.readFile(fullPath, 'utf-8')
    } catch {
      return `錯誤：找不到 ${command.path}`
    }
    const lines = content.split('\n')
    if (command.insert_line < 0 || command.insert_line > lines.length) {
      return `錯誤：insert_line ${command.insert_line} 超出範圍 [0, ${lines.length}]`
    }
    lines.splice(command.insert_line, 0, command.insert_text)
    await fs.writeFile(fullPath, lines.join('\n'), 'utf-8')
    return `已在第 ${command.insert_line} 行插入內容至 ${command.path}`
  }

  // DELETE：刪除檔案或目錄
  async delete(command: Parameters<MemoryToolHandlers['delete']>[0]): Promise<string> {
    const fullPath = this.resolveSafePath(command.path)
    try {
      await fs.rm(fullPath, { recursive: true, force: true })
      return `已刪除 ${command.path}`
    } catch {
      return `錯誤：找不到 ${command.path}`
    }
  }

  // RENAME：重新命名或移動檔案
  async rename(command: Parameters<MemoryToolHandlers['rename']>[0]): Promise<string> {
    const oldFull = this.resolveSafePath(command.old_path)
    const newFull = this.resolveSafePath(command.new_path)
    if (!existsSync(oldFull)) {
      return `錯誤：找不到 ${command.old_path}`
    }
    if (existsSync(newFull)) {
      return `錯誤：${command.new_path} 已存在`
    }
    await fs.rename(oldFull, newFull)
    return `已將 ${command.old_path} 重新命名為 ${command.new_path}`
  }
}

// 建立 Memory Tool 實例（供 toolRunner 使用）
// betaMemoryTool() 把我們的 handlers 包裝成 Claude 可呼叫的工具格式
const memoryHandlers = new FileSystemMemoryHandlers()
export const memoryTool = betaMemoryTool(memoryHandlers)
export { FileSystemMemoryHandlers }

// ─────────────────────────────────────────────────────────────────────────────
// Skills 架構說明
//
// 正確的 Skill 架構 = 工具（Tool） + 技能協議檔案（SKILL.md）
//
// 【之前的做法（錯誤）】
//   把完整的技能協議（啟動流程、解讀框架、應對策略）寫在 COUNSELOR_SYSTEM_PROMPT
//   → 每次對話都載入，不管需不需要
//   → System Prompt 臃腫，難以維護
//
// 【正確的做法（Skills 架構）】
//   System Prompt：只放技能的 metadata（名稱、描述、啟動時機）— 約 30 tokens
//   SKILL.md 檔案：完整的技能協議（存放於 server/skills/<skill-name>/SKILL.md）
//   read_skill 工具：Claude 判斷需要某技能時，呼叫此工具動態載入完整協議
//
// 工具分工：
//   read_skill       — 知識工具：動態載入 SKILL.md 的完整互動協議
//   show_mood_cards  — UI 工具：觸發前端渲染牌卡選擇介面（透過 SSE）
//   show_meditation  — UI 工具：觸發前端渲染冥想引導元件（透過 SSE）
// ─────────────────────────────────────────────────────────────────────────────

// SKILLS_DIR：技能檔案的存放根目錄
const SKILLS_DIR = path.resolve('./server/skills')

// readSkillTool：動態技能載入工具
// 當 Claude 根據對話情境判斷需要使用某技能時，先呼叫此工具載入完整協議，
// 再按照協議執行。這對應官方 Skills 架構中 Claude 讀取 SKILL.md 的機制。
const readSkillTool = {
  name: 'read_skill',
  description: `載入指定技能的完整互動協議（SKILL.md）。
使用時機：當你根據對話情境判斷應啟動某項技能時，先呼叫此工具取得完整協議，再按照協議執行。
重要：必須先讀取技能協議，再執行技能的任何步驟。`,
  input_schema: {
    type: 'object' as const,
    properties: {
      skill_name: {
        type: 'string',
        description: '技能名稱，對應 server/skills/ 目錄下的資料夾名稱',
        enum: ['mood-awareness-cards', 'meditation-guide'],
      },
    },
    required: ['skill_name'],
  },
  run: async (input: unknown) => {
    const { skill_name } = input as { skill_name: string }
    const skillPath = path.join(SKILLS_DIR, skill_name, 'SKILL.md')
    try {
      const content = await fs.readFile(skillPath, 'utf-8')
      console.log(`[Skill] 載入技能協議: ${skill_name}`)
      return content
    } catch {
      return `錯誤：找不到技能 "${skill_name}" 的協議檔案（路徑：${skillPath}）`
    }
  },
}

// ── 冥想引導技能型別 ──────────────────────────────────────────────────────────

export interface MeditationBreathing {
  inhale_seconds: number  // 吸氣秒數
  hold_seconds: number    // 屏氣秒數（0 = 略過）
  exhale_seconds: number  // 呼氣秒數
  rest_seconds: number    // 休息秒數（0 = 略過）
}

export interface MeditationEvent {
  title: string                  // 冥想主題，例如「正念呼吸」「焦慮舒緩」
  guidance: string               // 開場引導語（2-3 句，根據對話情境定制）
  duration_minutes: number       // 建議冥想時長（分鐘）
  breathing: MeditationBreathing // 呼吸節奏
}

// ── 牌卡技能型別 ──────────────────────────────────────────────────────────────

export interface MoodCard {
  id: string
  name: string         // 繁體中文名稱，例如「平靜」
  english_name: string // 英文名稱，例如「Calm」
  symbol: string       // Emoji，例如「🌊」
  color_theme: string  // 色彩主題，對應前端的 gradient mapping
  description: string  // 1-2 句繁體中文描述
}

export interface CardEvent {
  prompt: string    // Claude 的邀請語，例如「請選擇一張最能代表你現在心情的牌卡」
  cards: MoodCard[] // 4-6 張牌卡
}

function createMoodCardsTool(onCards: (event: CardEvent) => void) {
  return {
    name: 'show_mood_cards',
    // description 只描述 UI 機制，不包含技能知識
    // 完整的技能協議（何時啟動、如何引導、如何解讀、如何應對）在 SKILL.md 中
    // Claude 必須先呼叫 read_skill("mood-awareness-cards") 才能使用此工具
    description: `心情覺察牌卡的 UI 工具 — 觸發前端顯示牌卡選擇介面。
前提：必須已呼叫 read_skill("mood-awareness-cards") 載入技能協議。
呼叫後請勿輸出任何文字，靜待用戶選擇。`,
    input_schema: {
      type: 'object' as const,
      properties: {
        prompt: {
          type: 'string',
          description: '邀請用戶選牌的溫暖引導語（繁體中文）',
        },
        cards: {
          type: 'array',
          description: '要顯示的牌卡，選 4-6 張與當前話題最相關的',
          minItems: 4,
          maxItems: 6,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              name: { type: 'string', description: '繁體中文名稱' },
              english_name: { type: 'string' },
              symbol: { type: 'string', description: 'Emoji 符號' },
              color_theme: {
                type: 'string',
                enum: ['ocean', 'sunrise', 'forest', 'sunshine', 'blossom', 'mountain', 'lavender', 'moonlight'],
                description: '對應的色彩主題',
              },
              description: { type: 'string', description: '1-2 句繁體中文的直覺感受描述' },
            },
            required: ['id', 'name', 'english_name', 'symbol', 'color_theme', 'description'],
          },
        },
      },
      required: ['prompt', 'cards'],
    },
    // run 函數：Claude 呼叫工具時，toolRunner 自動執行這個函數
    // 透過 closure 存取外部的 onCards callback，
    // 把牌卡資料傳出去（最終透過 SSE 送到前端）
    run: async (input: unknown) => {
      onCards(input as CardEvent)
      return '心情覺察牌卡已顯示給用戶。請靜待用戶選擇，不需輸出任何文字。'
    },
  }
}

// createMeditationTool：冥想引導 UI 工具工廠
// 觸發前端渲染冥想引導元件（呼吸動畫、計時器、引導文字）
// 必須先呼叫 read_skill("meditation-guide") 載入完整協議再使用
function createMeditationTool(onMeditation: (event: MeditationEvent) => void) {
  return {
    name: 'show_meditation',
    description: `冥想引導的 UI 工具 — 觸發前端顯示冥想引導元件（呼吸動畫、計時器、引導文字）。
前提：必須已呼叫 read_skill("meditation-guide") 載入技能協議。
呼叫後請勿輸出任何文字，讓用戶進入冥想狀態。`,
    input_schema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: '冥想主題，例如「正念呼吸」「焦慮舒緩」「深度放鬆」',
        },
        guidance: {
          type: 'string',
          description: '個性化的開場引導語（2-3 句，根據用戶當前狀態定制，語氣溫柔平靜）',
        },
        duration_minutes: {
          type: 'number',
          description: '建議冥想時長（分鐘），通常 3-10 分鐘',
          minimum: 1,
          maximum: 30,
        },
        breathing: {
          type: 'object',
          description: '呼吸節奏設定',
          properties: {
            inhale_seconds:  { type: 'number', description: '吸氣秒數', minimum: 2, maximum: 10 },
            hold_seconds:    { type: 'number', description: '屏氣秒數，0 表示略過', minimum: 0, maximum: 10 },
            exhale_seconds:  { type: 'number', description: '呼氣秒數', minimum: 2, maximum: 10 },
            rest_seconds:    { type: 'number', description: '休息秒數，0 表示略過', minimum: 0, maximum: 10 },
          },
          required: ['inhale_seconds', 'hold_seconds', 'exhale_seconds', 'rest_seconds'],
        },
      },
      required: ['title', 'guidance', 'duration_minutes', 'breathing'],
    },
    run: async (input: unknown) => {
      onMeditation(input as MeditationEvent)
      return '冥想引導元件已顯示給用戶。請靜待用戶完成冥想，不需輸出任何文字。'
    },
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 心理諮詢 System Prompt
//
// System Prompt 的設計原則（Skills 架構）：
//   ✅ 放在這裡：角色定義、CBT 方法論、記憶指示、危機處理、Skills Registry
//   ❌ 不放這裡：技能的完整協議（改放 SKILL.md，由 read_skill 工具動態載入）
//
// Skills Registry 只包含：技能名稱、一句話描述、啟動時機關鍵字
// 完整的技能知識（解讀框架、應對策略、詳細流程）由 Claude 按需載入
// ─────────────────────────────────────────────────────────────────────────────

export const COUNSELOR_SYSTEM_PROMPT = `
You are a warm, compassionate psychological counseling assistant trained in Cognitive Behavioral Therapy (CBT) and evidence-based approaches. Respond in the same language the user uses (Traditional Chinese or English).

你是一位溫暖、富有同理心的心理諮詢助手，接受過認知行為治療（CBT）與實證諮詢方法的訓練。請以用戶使用的語言（繁體中文或英文）回應。

## 諮詢方式 / Approach

**積極傾聽 / Active Listening**
- 先反映和確認感受，再提供建議
- 使用開放式問題深化探索
- 摘要和轉述以展示理解

**CBT 技巧 / CBT Techniques**
- 協助辨識認知扭曲（非黑即白思考、災難化、個人化等）
- 引導行為活化和愉快活動計劃
- 支持思維記錄和認知重組
- 在適當時候介紹放鬆技巧（腹式呼吸、漸進式肌肉放鬆）

**文化敏感度 / Cultural Sensitivity**
- 了解東亞文化對心理健康污名的看法
- 承認家庭和社會義務是真實的壓力來源
- 認可尋求幫助所需的勇氣

## 記憶使用指示 / Memory Instructions

你有存取記憶系統的權限。請主動使用它來提供個人化、連貫的照護：

1. **用戶資料** (\`/memories/user_profile.xml\`) — 儲存：
   - 用戶姓名和偏好語言
   - 主要困擾和議題
   - 已建立的治療目標
   - 重要個人背景（家庭狀況、工作等）

2. **對話摘要** (\`/memories/session_summaries.xml\`) — 儲存：
   - 每次對話的日期和主要主題
   - 取得的進展和獲得的洞察
   - 佈置的功課或練習
   - 用戶對不同技巧的反應

3. **重複主題** (\`/memories/recurring_themes.xml\`) — 儲存：
   - 跨對話觀察到的模式
   - 已識別的觸發因素
   - 用戶展現的優勢和資源

**使用時機：**
- 對話開始時，先查看記憶以提供連貫性
- 發現重要資訊時，主動儲存
- 如果記憶檔案不存在，在需要時建立它

## 危機處理 / Crisis Protocol

如果用戶表達有自殺念頭、自傷或立即危險：

1. 以真誠的關心回應，不要驚慌失措
2. 直接詢問：「你有想要傷害自己的念頭嗎？」
3. 如果確認，提供危機資源：
   - **台灣**: 自殺防治專線 **1925**（24小時）、張老師專線 **1980**
   - **全球**: Crisis Text Line — 發送 HOME 至 741741
   - **國際**: findahelpline.com
4. 如有立即危險，鼓勵撥打緊急服務（119）或前往最近急診室
5. 不要結束對話，保持陪伴

## 專業界限 / Boundaries

- 你是支持工具，不是持牌治療師的替代品
- 定期提醒用戶可以並鼓勵尋求專業幫助
- 不要診斷任何精神健康狀況
- 在保持溫暖的同時維持適當的專業界限

## 可用技能（Skills Registry）

以下技能的完整協議存放於獨立的 SKILL.md 檔案中。
**使用任何技能前，必須先呼叫 \`read_skill\` 工具載入完整協議，再按協議執行。**

| 技能名稱 | 說明 | 建議啟動時機 |
|---------|------|------------|
| mood-awareness-cards | 心情覺察牌卡 — 透過直覺式視覺選擇幫助接觸深層情緒 | 用戶難以言語化情緒（說不清楚/很複雜/不知道）；對話開始的暖身；對話陷入瓶頸；用戶過度理智化 |
| meditation-guide | 冥想引導 — 結構化呼吸練習幫助放鬆、減壓、穩定身心 | 用戶說「太緊張」「好焦慮」「需要放鬆」「想冥想」；情緒激動需先穩定；明確要求呼吸練習 |
`.trim()

// ─────────────────────────────────────────────────────────────────────────────
// 核心函數：串流諮詢回應
//
// 原理：
// 1. 把用戶訊息加入短期記憶
// 2. 用 toolRunner 啟動 Agent 迴圈：
//    Claude → 工具呼叫（讀/寫記憶）→ Claude → ... → 最終文字回覆
// 3. 透過 runner.on('text') 把文字串流傳給呼叫者
// 4. 把最終文字存回短期記憶
// ─────────────────────────────────────────────────────────────────────────────

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
})

export async function streamCounselorResponse(
  sessionId: string,
  userMessage: string,
  onTextDelta: (text: string) => void,
  onCards: (event: CardEvent) => void,
  onMeditation: (event: MeditationEvent) => void,
  onDone: () => void,
  onError: (err: Error) => void
): Promise<void> {
  // 1. 把用戶訊息加入短期記憶
  addToSession(sessionId, 'user', userMessage)

  // 2. 從短期記憶取得完整對話歷史
  const messages = getSession(sessionId).map((m) => ({
    role: m.role as 'user' | 'assistant',
    content: m.content,
  }))

  let fullAssistantText = ''

  try {
    // 3. 啟動 toolRunner（串流模式）
    //
    // TypeScript SDK 的串流方式：加上 stream: true，用 for await 雙層迴圈讀取
    //
    // 外層迴圈 = 每一輪 Agent 迭代（一次 API 呼叫）
    //   Claude 可能先呼叫 memory 工具，runner 自動執行後再發一次 API 呼叫
    //   每次 API 呼叫都是一個 messageStream
    //
    // 內層迴圈 = 單次 API 呼叫中的串流事件
    //   content_block_delta + text_delta = Claude 正在輸出文字
    //
    // 注意：runner.on('text', ...) 是 Python SDK 的寫法，TypeScript 不支援
    const runner = anthropic.beta.messages.toolRunner({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 4096,
      system: COUNSELOR_SYSTEM_PROMPT,
      // 工具列表：
      //   memoryTool          — 長期記憶讀寫（永久載入）
      //   readSkillTool       — 技能協議動態載入（永久載入，但協議內容按需讀取）
      //   createMoodCardsTool — 牌卡 UI 觸發（永久載入，但必須先讀取技能協議才使用）
      tools: [memoryTool, readSkillTool, createMoodCardsTool(onCards), createMeditationTool(onMeditation)],
      betas: ['context-management-2025-06-27'],
      messages,
      max_iterations: 10,
      stream: true,  // 啟用串流模式
    })

    // 4. 雙層 for await 迴圈讀取串流
    for await (const messageStream of runner) {
      // messageStream = 單次 API 呼叫的串流
      for await (const event of messageStream) {
        if (
          event.type === 'content_block_delta' &&
          event.delta.type === 'text_delta'
        ) {
          // 每個文字片段即時傳給前端（透過 SSE）
          fullAssistantText += event.delta.text
          onTextDelta(event.delta.text)
        }
      }
    }

    // 5. 把最終文字存入短期記憶
    if (fullAssistantText.trim()) {
      addToSession(sessionId, 'assistant', fullAssistantText)
    }

    onDone()
  } catch (err) {
    onError(err instanceof Error ? err : new Error(String(err)))
  }
}
