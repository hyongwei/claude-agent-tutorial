/**
 * App.tsx — 心理諮詢聊天介面
 *
 * 架構說明：
 * - 主元件 App：管理所有狀態、處理訊息發送和 SSE 串流
 * - MessageBubble：單則訊息的顯示元件
 * - ThinkingIndicator：等待回覆時的動畫
 * - WelcomeScreen：初始歡迎畫面
 * - ErrorBanner：錯誤提示
 *
 * 資料流：
 * 用戶輸入 → handleSend() → POST /api/chat
 *   → SSE 串流 → 逐字更新 messages state
 *   → React 重新渲染 → 訊息出現在畫面上
 */

import { useState, useEffect, useRef } from 'react'

// ─────────────────────────────────────────────────────────────────────────────
// TypeScript 型別定義
// ─────────────────────────────────────────────────────────────────────────────

interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
  timestamp: Date
}

// ─────────────────────────────────────────────────────────────────────────────
// Session ID 管理
//
// crypto.randomUUID() 是瀏覽器和 Node.js 內建的 UUID 生成器，不需要額外套件
// localStorage 讓 session ID 在瀏覽器重整後依然存在
// ─────────────────────────────────────────────────────────────────────────────

function getOrCreateSessionId(): string {
  const KEY = 'counselor_session_id'
  const existing = localStorage.getItem(KEY)
  if (existing) return existing
  const id = crypto.randomUUID()
  localStorage.setItem(KEY, id)
  return id
}

// ─────────────────────────────────────────────────────────────────────────────
// 主元件
// ─────────────────────────────────────────────────────────────────────────────

export default function App() {
  // useState：React 的狀態管理 hook
  // 每當 state 改變，React 會重新渲染元件
  const [sessionId] = useState<string>(getOrCreateSessionId)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // useRef：用來取得 DOM 元素的參照，不會觸發重新渲染
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // useEffect：副作用 hook — 當 messages 改變時，自動捲動到底部
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ───────────────────────────────────────────────────────────────────────────
  // 發送訊息並讀取 SSE 串流
  //
  // 這個函數展示了如何：
  // 1. 樂觀更新（先更新 UI，再等 server 確認）
  // 2. 讀取 ReadableStream
  // 3. 解析 SSE 事件
  // 4. 逐字更新 React state
  // ───────────────────────────────────────────────────────────────────────────

  async function sendMessage(userText: string) {
    // 1. 樂觀更新：立即把用戶訊息加到畫面上（不等 server 確認）
    const userMsg: Message = {
      id: crypto.randomUUID(),
      role: 'user',
      content: userText,
      timestamp: new Date(),
    }

    // 2. 建立空白的助手訊息佔位符（待填入串流內容）
    const assistantId = crypto.randomUUID()
    const assistantMsg: Message = {
      id: assistantId,
      role: 'assistant',
      content: '',
      timestamp: new Date(),
    }

    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setIsLoading(true)
    setError(null)

    try {
      // 3. 發送 POST 請求到後端
      const response = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId, message: userText }),
      })

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}))
        throw new Error(
          (errData as { error?: string }).error ?? `HTTP ${response.status}`
        )
      }

      // 4. 取得 ReadableStream 讀取器
      const reader = response.body!.getReader()
      const decoder = new TextDecoder()
      let buffer = '' // 暫存不完整的行

      // 5. 迴圈讀取串流資料
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        // 把 Uint8Array 轉成字串，stream: true 表示可能有多位元組字元
        buffer += decoder.decode(value, { stream: true })

        // SSE 格式：每個事件以兩個換行 \n\n 分隔
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? '' // 最後一段可能不完整，留著下次處理

        for (const line of lines) {
          // SSE 的資料行以 "data: " 開頭
          if (line.startsWith('data: ')) {
            const rawJson = line.slice(6) // 移除 "data: " 前綴
            try {
              const data = JSON.parse(rawJson) as
                | { text: string }
                | { status: string }
                | { message: string }

              if ('text' in data) {
                // delta 事件：把新文字附加到助手訊息
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantId
                      ? { ...m, content: m.content + data.text }
                      : m
                  )
                )
              } else if ('status' in data && data.status === 'complete') {
                // done 事件：串流結束
                setIsLoading(false)
              } else if ('message' in data) {
                // error 事件：後端發生錯誤
                throw new Error(data.message)
              }
            } catch {
              // 忽略無法解析的行（例如 event: delta 這樣的事件名稱行）
            }
          }
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '連線發生錯誤')
      setIsLoading(false)
    }
  }

  // 鍵盤事件：Enter 發送，Shift+Enter 換行
  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  function handleSend() {
    if (!input.trim() || isLoading) return
    const text = input.trim()
    setInput('')
    sendMessage(text)
  }

  // ───────────────────────────────────────────────────────────────────────────
  // UI 渲染
  // ───────────────────────────────────────────────────────────────────────────

  // 最後一則訊息是空白的助手訊息 = 正在等待回覆
  const isWaitingForResponse =
    isLoading &&
    messages.length > 0 &&
    messages[messages.length - 1].role === 'assistant' &&
    messages[messages.length - 1].content === ''

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      {/* ── 頂部標題列 ── */}
      <header className="bg-white border-b border-slate-200 px-4 py-3 flex items-center gap-3 shadow-sm flex-shrink-0">
        <div className="w-9 h-9 rounded-full bg-teal-500 flex items-center justify-center text-white font-bold text-lg select-none">
          心
        </div>
        <div>
          <h1 className="font-semibold text-slate-800 text-sm">心理諮詢助手</h1>
          <p className="text-xs text-slate-500">Psychological Counseling Assistant</p>
        </div>
        {/* 顯示部分 session ID，方便 debug */}
        <span className="ml-auto text-xs text-slate-400 font-mono hidden sm:block">
          Session: {sessionId.slice(0, 8)}…
        </span>
      </header>

      {/* ── 訊息區域 ── */}
      <main className="flex-1 overflow-y-auto px-4 py-6 space-y-4 max-w-3xl w-full mx-auto">
        {messages.length === 0 && !isLoading && <WelcomeScreen />}

        {messages.map((msg) =>
          // 跳過空白的佔位訊息（等待中的助手訊息，用 ThinkingIndicator 代替）
          msg.role === 'assistant' && msg.content === '' ? null : (
            <MessageBubble key={msg.id} message={msg} />
          )
        )}

        {isWaitingForResponse && <ThinkingIndicator />}

        {error && (
          <ErrorBanner message={error} onDismiss={() => setError(null)} />
        )}

        {/* 錨點：用來自動捲動到底部 */}
        <div ref={messagesEndRef} />
      </main>

      {/* ── 底部輸入區 ── */}
      <footer className="bg-white border-t border-slate-200 px-4 py-3 flex-shrink-0">
        <div className="flex gap-2 items-end max-w-3xl mx-auto">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="分享你的感受... / Share how you're feeling..."
            rows={1}
            disabled={isLoading}
            className="flex-1 resize-none rounded-xl border border-slate-300 px-4 py-3 text-sm
                       focus:outline-none focus:ring-2 focus:ring-teal-400 focus:border-transparent
                       placeholder:text-slate-400 max-h-40 overflow-y-auto
                       disabled:bg-slate-50 disabled:text-slate-400"
          />
          <button
            onClick={handleSend}
            disabled={isLoading || !input.trim()}
            className="rounded-xl bg-teal-500 hover:bg-teal-600 active:bg-teal-700
                       disabled:bg-slate-300 disabled:cursor-not-allowed
                       text-white px-4 py-3 text-sm font-medium transition-colors
                       focus-visible:outline focus-visible:outline-2 focus-visible:outline-teal-500
                       whitespace-nowrap"
          >
            {isLoading ? '…' : '發送'}
          </button>
        </div>
        <p className="text-xs text-center text-slate-400 mt-2">
          此工具不能取代專業心理治療。如有緊急危機，請撥打{' '}
          <span className="font-semibold text-slate-500">1925</span>（台灣自殺防治專線）
        </p>
      </footer>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 子元件
// ─────────────────────────────────────────────────────────────────────────────

function MessageBubble({ message }: { message: Message }) {
  const isUser = message.role === 'user'
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} items-end gap-2`}>
      {/* 助手頭像（只在左側顯示）*/}
      {!isUser && (
        <div className="w-7 h-7 rounded-full bg-teal-100 flex items-center justify-center text-teal-600 text-xs flex-shrink-0 mb-0.5 select-none">
          心
        </div>
      )}
      <div
        className={[
          'max-w-[75%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap',
          isUser
            ? 'bg-teal-500 text-white rounded-tr-sm'
            : 'bg-white text-slate-800 shadow-sm border border-slate-100 rounded-tl-sm',
        ].join(' ')}
      >
        {message.content}
      </div>
    </div>
  )
}

// 三個跳動的點，表示 Claude 正在思考或呼叫工具
function ThinkingIndicator() {
  return (
    <div className="flex items-end gap-2">
      <div className="w-7 h-7 rounded-full bg-teal-100 flex items-center justify-center text-teal-600 text-xs flex-shrink-0 select-none">
        心
      </div>
      <div className="bg-white border border-slate-100 shadow-sm rounded-2xl rounded-tl-sm px-4 py-3">
        <div className="flex gap-1 items-center h-4">
          <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce [animation-delay:-0.3s]" />
          <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce [animation-delay:-0.15s]" />
          <span className="w-2 h-2 bg-slate-400 rounded-full animate-bounce" />
        </div>
      </div>
    </div>
  )
}

// 初始歡迎畫面（無訊息時顯示）
function WelcomeScreen() {
  return (
    <div className="flex flex-col items-center justify-center min-h-[50vh] text-center">
      <div className="w-16 h-16 rounded-full bg-teal-100 flex items-center justify-center text-3xl mb-6 select-none">
        心
      </div>
      <h2 className="text-slate-700 font-semibold text-lg mb-2">
        歡迎 / Welcome
      </h2>
      <p className="text-slate-500 text-sm max-w-sm leading-relaxed">
        你好！我是你的心理諮詢助手。我在這裡陪伴你，請告訴我今天你有什麼感受或想聊的事情。
      </p>
      <p className="text-slate-400 text-xs mt-3 max-w-sm leading-relaxed">
        Hello! I'm your psychological counseling assistant. I'm here for you — please share how you're feeling today.
      </p>
      <div className="mt-6 flex gap-2 flex-wrap justify-center">
        {['我最近壓力很大', '我感到焦慮', 'I need someone to talk to', '我想改善情緒'].map(
          (suggestion) => (
            <span
              key={suggestion}
              className="text-xs bg-teal-50 text-teal-700 border border-teal-200 rounded-full px-3 py-1.5 cursor-default"
            >
              {suggestion}
            </span>
          )
        )}
      </div>
    </div>
  )
}

// 錯誤提示橫幅
function ErrorBanner({
  message,
  onDismiss,
}: {
  message: string
  onDismiss: () => void
}) {
  return (
    <div className="bg-red-50 border border-red-200 rounded-xl px-4 py-3 flex items-start justify-between gap-3">
      <p className="text-red-700 text-sm">{message}</p>
      <button
        onClick={onDismiss}
        className="text-red-400 hover:text-red-600 text-xs flex-shrink-0 mt-0.5"
      >
        關閉
      </button>
    </div>
  )
}
