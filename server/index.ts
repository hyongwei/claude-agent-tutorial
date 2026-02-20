/**
 * server/index.ts — Express 後端伺服器
 *
 * 職責：
 * 1. 提供 POST /api/chat 端點
 * 2. 用 SSE（Server-Sent Events）把 Claude 的回覆串流給前端
 * 3. 驗證請求參數
 * 4. 初始化記憶目錄
 *
 * SSE 工作原理：
 * - Content-Type: text/event-stream 告訴瀏覽器這是串流連線
 * - 每個事件格式：`event: <名稱>\ndata: <JSON>\n\n`
 * - 連線保持開啟，直到我們呼叫 res.end()
 */

import 'dotenv/config'   // 第一行載入 .env，確保 API Key 在環境變數中
import express from 'express'
import cors from 'cors'
import { FileSystemMemoryHandlers, streamCounselorResponse } from './counselor.js'

const app = express()
const PORT = 3001

// ─────────────────────────────────────────────────────────────────────────────
// Middleware（中介軟體）
//
// Middleware 是在請求進到路由處理前先執行的函數
// ─────────────────────────────────────────────────────────────────────────────

// CORS：允許前端（Vite dev server on :5173）呼叫這個後端
// 在生產環境，這裡要換成你的真實網域
app.use(
  cors({
    origin: ['http://localhost:5173', 'http://localhost:4173'],
    credentials: true,
  })
)

// JSON body parser：讓我們可以讀取 req.body
app.use(express.json())

// ─────────────────────────────────────────────────────────────────────────────
// 路由
// ─────────────────────────────────────────────────────────────────────────────

// 健康檢查端點（用來確認 server 是否在線）
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() })
})

// 聊天端點 — 核心功能
app.post('/api/chat', async (req, res) => {
  // 1. 驗證請求參數
  const { sessionId, message } = req.body as {
    sessionId?: string
    message?: string
  }

  if (!sessionId || typeof sessionId !== 'string') {
    res.status(400).json({ error: 'sessionId 為必填欄位' })
    return
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message 為必填欄位' })
    return
  }

  // 2. 設定 SSE 回應標頭
  //    這些 header 告訴瀏覽器「這是一個持續的串流連線」
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no') // 停用 Nginx 緩衝（如果有的話）
  res.flushHeaders() // 立即把 header 送出去，不要等到有資料

  // 3. 輔助函數：發送 SSE 事件
  //    格式：`event: <name>\ndata: <json>\n\n`
  const sendEvent = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }

  console.log(`[Chat] Session ${sessionId.slice(0, 8)}... 收到訊息`)

  // 4. 呼叫核心諮詢函數（在 counselor.ts 中定義）
  await streamCounselorResponse(
    sessionId,
    message.trim(),

    // onTextDelta：Claude 輸出文字時 → SSE 'delta' 事件
    (text) => {
      sendEvent('delta', { text })
    },

    // onCards：Claude 呼叫 show_mood_cards 工具時 → SSE 'cards' 事件
    // 前端收到後會渲染牌卡選擇 UI
    (cardEvent) => {
      sendEvent('cards', cardEvent)
    },

    // onMeditation：Claude 呼叫 show_meditation 工具時 → SSE 'meditation' 事件
    // 前端收到後會渲染冥想引導元件（呼吸動畫、計時器、引導文字）
    (meditationEvent) => {
      sendEvent('meditation', meditationEvent)
    },

    // onDone：Agent 迴圈完成時
    () => {
      sendEvent('done', { status: 'complete' })
      res.end()
      console.log(`[Chat] Session ${sessionId.slice(0, 8)}... 回覆完成`)
    },

    // onError：發生錯誤時
    (err) => {
      console.error(`[Chat] 錯誤:`, err.message)
      sendEvent('error', { message: err.message })
      res.end()
    }
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// 啟動伺服器
//
// 先初始化記憶目錄（建立 server/memories/ 資料夾），
// 再啟動 HTTP 伺服器
// ─────────────────────────────────────────────────────────────────────────────

FileSystemMemoryHandlers.init()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`\n✅ 心理諮詢後端伺服器啟動中`)
      console.log(`   http://localhost:${PORT}`)
      console.log(`   健康檢查: http://localhost:${PORT}/api/health\n`)
    })
  })
  .catch((err: unknown) => {
    console.error('❌ 初始化失敗:', err)
    process.exit(1)
  })
