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

// 牌卡型別（對應後端 server/counselor.ts 的 MoodCard / CardEvent）
interface MoodCard {
  id: string
  name: string         // 繁體中文，例如「平靜」
  english_name: string // 例如「Calm」
  symbol: string       // Emoji，例如「🌊」
  color_theme: string  // 對應 GRADIENTS 的 key
  description: string  // 1-2 句描述
}

interface CardEvent {
  prompt: string    // Claude 的邀請語
  cards: MoodCard[]
}

// 冥想引導型別（對應後端 MeditationBreathing / MeditationEvent）
interface MeditationBreathing {
  inhale_seconds: number
  hold_seconds: number
  exhale_seconds: number
  rest_seconds: number
}

interface MeditationEvent {
  title: string
  guidance: string
  duration_minutes: number
  breathing: MeditationBreathing
}

// 牌卡色彩主題 → CSS gradient
// 用 inline style 而非 Tailwind 動態 class，因為 Tailwind JIT 無法處理動態 class 名稱
const GRADIENTS: Record<string, string> = {
  ocean:    'linear-gradient(135deg, #60a5fa, #22d3ee)',
  sunrise:  'linear-gradient(135deg, #fb923c, #f472b6)',
  forest:   'linear-gradient(135deg, #4ade80, #059669)',
  sunshine: 'linear-gradient(135deg, #fbbf24, #f97316)',
  blossom:  'linear-gradient(135deg, #f472b6, #c084fc)',
  mountain: 'linear-gradient(135deg, #94a3b8, #60a5fa)',
  lavender: 'linear-gradient(135deg, #c084fc, #818cf8)',
  moonlight:'linear-gradient(135deg, #6366f1, #7c3aed)',
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
  // pendingCards：當後端發來 'cards' SSE 事件時，儲存牌卡資料並渲染選擇 UI
  const [pendingCards, setPendingCards] = useState<CardEvent | null>(null)
  // pendingMeditation：當後端發來 'meditation' SSE 事件時，儲存冥想設定並渲染引導 UI
  const [pendingMeditation, setPendingMeditation] = useState<MeditationEvent | null>(null)

  // useRef：用來取得 DOM 元素的參照，不會觸發重新渲染
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 追蹤「目前正在讀取的串流 ID」，防止舊串流的更新汙染新的對話輪次
  const activeStreamId = useRef<string>('')

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

    // 為這次串流產生唯一 ID，用來過濾「舊串流的遲到更新」
    // 場景：用戶選牌後立刻發新訊息，舊串流的 delta 不應污染新對話
    const streamId = crypto.randomUUID()
    activeStreamId.current = streamId

    setMessages((prev) => [...prev, userMsg, assistantMsg])
    setIsLoading(true)
    setError(null)
    setPendingCards(null)     // 開始新的對話輪次時，清除殘留的牌卡 UI
    setPendingMeditation(null) // 清除殘留的冥想 UI

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

        // 如果這個串流已不是最新的（用戶選牌後又發了新訊息），停止讀取
        if (activeStreamId.current !== streamId) break

        // 把 Uint8Array 轉成字串，stream: true 表示可能有多位元組字元
        buffer += decoder.decode(value, { stream: true })

        // SSE 格式：每個事件以兩個換行 \n\n 分隔
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? '' // 最後一段可能不完整，留著下次處理

        for (const line of lines) {
          // SSE 的資料行以 "data: " 開頭
          if (line.startsWith('data: ')) {
            const rawJson = line.slice(6) // 移除 "data: " 前綴

            let data: Record<string, unknown>
            try {
              data = JSON.parse(rawJson) as Record<string, unknown>
            } catch {
              // 忽略非 JSON 的行（例如 "event: delta" 這樣的事件名稱行）
              continue
            }

            // 將解析成功的事件分派到對應的處理邏輯
            // 注意：error 事件的 throw 在這裡（不在 JSON.parse 的 try 內），
            //       才能被外層 catch 捕捉到並顯示錯誤
            if ('text' in data && typeof data.text === 'string') {
              // delta 事件：把新文字附加到助手訊息
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantId
                    ? { ...m, content: m.content + (data.text as string) }
                    : m
                )
              )
            } else if ('cards' in data && Array.isArray(data.cards)) {
              // cards 事件：Claude 呼叫了 show_mood_cards 工具
              // 驗證 cards 是陣列才設定，防止 Claude 回傳非預期格式導致渲染崩潰
              setPendingCards(data as unknown as CardEvent)
            } else if ('breathing' in data) {
              // meditation 事件：Claude 呼叫了 show_meditation 工具
              setPendingMeditation(data as unknown as MeditationEvent)
            } else if ('status' in data && data.status === 'complete') {
              // done 事件：串流結束
              setIsLoading(false)
            } else if ('message' in data && typeof data.message === 'string') {
              // error 事件：後端發生錯誤，拋出讓外層 catch 處理
              throw new Error(data.message as string)
            }
          }
        }
      }
    } catch (err) {
      // 只在這個串流仍是最新時才顯示錯誤，避免舊串流的錯誤覆蓋新對話
      if (activeStreamId.current === streamId) {
        setError(err instanceof Error ? err.message : '連線發生錯誤')
        setIsLoading(false)
        // 移除沒有收到任何內容的空白助手佔位訊息，保持訊息列表整潔
        setMessages((prev) => prev.filter(
          (m) => !(m.id === assistantId && m.content === '')
        ))
      }
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

  // 冥想完成或提前結束後：清除冥想 UI，把結果作為訊息送出
  function handleMeditationComplete(completed: boolean, elapsedSeconds: number) {
    if (isLoading) return
    setPendingMeditation(null)
    const mins = Math.floor(elapsedSeconds / 60)
    const secs = elapsedSeconds % 60
    const timeStr = mins > 0 ? `${mins} 分 ${secs} 秒` : `${secs} 秒`
    if (completed) {
      sendMessage(`我完成了冥想練習，共進行了 ${timeStr}。`)
    } else {
      sendMessage(`我提前結束了冥想，共進行了 ${timeStr}。`)
    }
  }

  // 用戶選擇牌卡後：清除牌卡 UI，把選擇作為訊息送出
  // Claude 會根據選擇啟動「用戶選擇後的回應框架」（在 System Prompt 中定義）
  function handleCardSelect(card: MoodCard) {
    // 防止 isLoading 為 true 時的重複觸發（例如雙擊）
    if (isLoading) return
    // sendMessage 內部也會 setPendingCards(null)，這裡提前清除確保視覺即時性
    setPendingCards(null)
    sendMessage(`我選擇了「${card.name}」${card.symbol}\n（${card.description}）`)
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

        {/* 牌卡選擇 UI：Claude 呼叫 show_mood_cards 後顯示 */}
        {pendingCards && (
          <CardSelection
            event={pendingCards}
            onSelect={handleCardSelect}
            disabled={isLoading}
          />
        )}

        {/* 冥想引導 UI：Claude 呼叫 show_meditation 後顯示 */}
        {pendingMeditation && (
          <MeditationGuide
            event={pendingMeditation}
            onComplete={handleMeditationComplete}
          />
        )}

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

// ─────────────────────────────────────────────────────────────────────────────
// 心情覺察牌卡選擇元件
//
// 學習重點：
// - inline style 用於動態 CSS（不能用 Tailwind 動態 class）
// - disabled prop 讓牌卡在 loading 時不可點選
// - 點選後呼叫 onSelect，由父元件清除 pendingCards 並送出訊息
// ─────────────────────────────────────────────────────────────────────────────

function CardSelection({
  event,
  onSelect,
  disabled,
}: {
  event: CardEvent
  onSelect: (card: MoodCard) => void
  disabled: boolean
}) {
  return (
    <div className="my-4">
      {/* Claude 的邀請語 */}
      <div className="flex items-end gap-2 mb-4">
        <div className="w-7 h-7 rounded-full bg-teal-100 flex items-center justify-center text-teal-600 text-xs flex-shrink-0 select-none">
          心
        </div>
        <div className="bg-white border border-slate-100 shadow-sm rounded-2xl rounded-tl-sm px-4 py-3 text-sm text-slate-800 leading-relaxed">
          {event.prompt}
        </div>
      </div>

      {/* 牌卡格狀排列 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 ml-9">
        {event.cards.map((card) => (
          <button
            key={card.id}
            type="button"
            onClick={() => !disabled && onSelect(card)}
            disabled={disabled}
            className={[
              'rounded-2xl p-4 text-white text-left transition-all duration-200 shadow-md',
              disabled
                ? 'opacity-60 cursor-not-allowed'
                : 'hover:scale-105 hover:shadow-xl active:scale-95 cursor-pointer',
            ].join(' ')}
            style={{ background: GRADIENTS[card.color_theme] ?? GRADIENTS.ocean }}
          >
            {/* 大 Emoji 符號 */}
            <div className="text-3xl mb-2 leading-none">{card.symbol}</div>
            {/* 中文名稱 */}
            <div className="font-bold text-sm leading-tight">{card.name}</div>
            {/* 英文名稱 */}
            <div className="text-xs opacity-80 mt-0.5">{card.english_name}</div>
            {/* 描述（小字，限兩行）*/}
            <div className="text-xs opacity-75 mt-2 leading-snug line-clamp-2">
              {card.description}
            </div>
          </button>
        ))}
      </div>
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// 冥想引導元件
//
// 設計：
// - useEffect 每秒遞增 elapsed，到達 totalSeconds 時標記 isDone
// - 從 elapsed % cycleDuration 即時推導呼吸階段與 scale（1.0 ~ 1.5）
// - 呼吸圓用 transform: scale() + transition 1s 實現平滑動畫
// - 完成時顯示「繼續對話」；進行中顯示「提前結束」
// ─────────────────────────────────────────────────────────────────────────────

function MeditationGuide({
  event,
  onComplete,
}: {
  event: MeditationEvent
  onComplete: (completed: boolean, elapsedSeconds: number) => void
}) {
  const [elapsed, setElapsed] = useState(0)
  const [isDone, setIsDone] = useState(false)

  const totalSeconds = event.duration_minutes * 60
  const { inhale_seconds, hold_seconds, exhale_seconds, rest_seconds } = event.breathing
  const cycleDuration = inhale_seconds + hold_seconds + exhale_seconds + rest_seconds

  // 每秒遞增計時器
  useEffect(() => {
    if (isDone) return
    const id = setInterval(() => {
      setElapsed((e) => {
        const next = e + 1
        if (next >= totalSeconds) {
          setIsDone(true)
          return totalSeconds
        }
        return next
      })
    }, 1000)
    return () => clearInterval(id)
  }, [isDone, totalSeconds])

  // 從當前時間推導呼吸階段
  const phaseElapsed = elapsed % cycleDuration

  let phase: string
  let scale: number
  let phaseRemaining: number

  if (phaseElapsed < inhale_seconds) {
    phase = '吸氣'
    const progress = phaseElapsed / inhale_seconds
    scale = 1.0 + 0.5 * progress
    phaseRemaining = inhale_seconds - phaseElapsed
  } else if (phaseElapsed < inhale_seconds + hold_seconds) {
    phase = '屏氣'
    scale = 1.5
    phaseRemaining = inhale_seconds + hold_seconds - phaseElapsed
  } else if (phaseElapsed < inhale_seconds + hold_seconds + exhale_seconds) {
    phase = '呼氣'
    const progress = (phaseElapsed - inhale_seconds - hold_seconds) / exhale_seconds
    scale = 1.5 - 0.5 * progress
    phaseRemaining = inhale_seconds + hold_seconds + exhale_seconds - phaseElapsed
  } else {
    phase = rest_seconds > 0 ? '休息' : '呼氣'
    scale = 1.0
    phaseRemaining = cycleDuration - phaseElapsed
  }

  const progressPercent = Math.min((elapsed / totalSeconds) * 100, 100)
  const remaining = totalSeconds - elapsed
  const remainMins = Math.floor(remaining / 60)
  const remainSecs = remaining % 60

  return (
    <div className="my-4 ml-9 flex flex-col items-center bg-gradient-to-b from-slate-50 to-white rounded-3xl border border-slate-100 shadow-lg px-8 py-8">
      {/* 標題與引導語 */}
      <h3 className="text-slate-700 font-semibold text-base mb-1">{event.title}</h3>
      <p className="text-slate-500 text-sm text-center mb-8 max-w-xs leading-relaxed">
        {event.guidance}
      </p>

      {/* 呼吸動畫圓 — 固定大小容器，圓圈用 transform scale 縮放 */}
      <div className="relative flex items-center justify-center mb-8" style={{ width: 200, height: 200 }}>
        {/* 外圈光暈 */}
        <div
          className="absolute rounded-full bg-teal-100"
          style={{
            width: 160,
            height: 160,
            transform: `scale(${scale})`,
            transition: 'transform 1s ease-in-out',
            opacity: 0.35,
          }}
        />
        {/* 主圓：顯示階段和倒數 */}
        <div
          className="relative z-10 flex flex-col items-center justify-center rounded-full text-white shadow-md"
          style={{
            width: 120,
            height: 120,
            background: 'linear-gradient(135deg, #2dd4bf, #0891b2)',
            transform: `scale(${scale})`,
            transition: 'transform 1s ease-in-out',
          }}
        >
          <span className="text-3xl font-bold leading-none">{Math.ceil(phaseRemaining)}</span>
          <span className="text-sm mt-1 opacity-90">{isDone ? '完成' : phase}</span>
        </div>
      </div>

      {/* 進度條 */}
      <div className="w-full max-w-xs bg-slate-100 rounded-full h-1.5 mb-2">
        <div
          className="bg-teal-400 h-1.5 rounded-full transition-all duration-1000"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      {/* 剩餘時間 */}
      <p className="text-xs text-slate-400 mb-6">
        {isDone
          ? '✨ 冥想完成'
          : `剩餘 ${remainMins}:${String(remainSecs).padStart(2, '0')}`}
      </p>

      {/* 操作按鈕 */}
      {isDone ? (
        <button
          type="button"
          onClick={() => onComplete(true, elapsed)}
          className="bg-teal-500 hover:bg-teal-600 active:bg-teal-700 text-white rounded-xl px-6 py-2.5 text-sm font-medium transition-colors"
        >
          繼續對話
        </button>
      ) : (
        <button
          type="button"
          onClick={() => onComplete(false, elapsed)}
          className="text-slate-400 hover:text-slate-600 text-xs transition-colors"
        >
          提前結束冥想
        </button>
      )}
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
