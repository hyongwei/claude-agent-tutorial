import { useState } from 'react'

interface Agent {
  id: number
  name: string
  status: 'active' | 'idle'
  createdAt: string
}

let nextId = 1

function App() {
  const [agents, setAgents] = useState<Agent[]>([])

  function addAgent() {
    const id = nextId++
    setAgents(prev => [
      ...prev,
      {
        id,
        name: `Agent ${id}`,
        status: 'idle',
        createdAt: new Date().toLocaleTimeString(),
      },
    ])
  }

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-12">
      <div className="mx-auto max-w-2xl">

        {/* Header */}
        <div className="mb-10 text-center">
          <h1 className="text-4xl font-bold tracking-tight text-gray-900 sm:text-5xl">
            My First Agent Dashboard
          </h1>
          <p className="mt-3 text-gray-500 text-sm">
            Manage and monitor your AI agents
          </p>
        </div>

        {/* Add Agent button */}
        <div className="flex justify-center mb-8">
          <button
            onClick={addAgent}
            className="inline-flex items-center gap-2 rounded-lg bg-blue-600 px-6 py-3 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 active:bg-blue-800 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            <span className="text-lg leading-none">+</span>
            Add New Agent
          </button>
        </div>

        {/* Agent list */}
        {agents.length === 0 ? (
          <div className="rounded-xl border-2 border-dashed border-gray-200 bg-white px-6 py-16 text-center">
            <div className="text-4xl mb-3">🤖</div>
            <p className="text-gray-500 font-medium">No agents yet.</p>
            <p className="text-gray-400 text-sm mt-1">
              Click above to add your first agent.
            </p>
          </div>
        ) : (
          <ul className="space-y-3">
            {agents.map(agent => (
              <li
                key={agent.id}
                className="flex items-center justify-between rounded-xl border border-gray-200 bg-white px-5 py-4 shadow-sm"
              >
                <div className="flex items-center gap-3">
                  <span className="flex h-9 w-9 items-center justify-center rounded-full bg-blue-100 text-blue-600 font-bold text-sm">
                    {agent.id}
                  </span>
                  <div>
                    <p className="font-semibold text-gray-800">{agent.name}</p>
                    <p className="text-xs text-gray-400">Added at {agent.createdAt}</p>
                  </div>
                </div>
                <span className="inline-flex items-center gap-1.5 rounded-full bg-gray-100 px-3 py-1 text-xs font-medium text-gray-600">
                  <span className="h-1.5 w-1.5 rounded-full bg-gray-400" />
                  {agent.status}
                </span>
              </li>
            ))}
          </ul>
        )}

      </div>
    </div>
  )
}

export default App
