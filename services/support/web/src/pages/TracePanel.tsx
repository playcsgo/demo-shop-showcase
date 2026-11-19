import { useState } from 'react'
import { api } from '../api.ts'

interface ToolCall {
  tool: string
  status: string
  duration_ms: number
  args_json: unknown
  result_json: unknown
}
interface Run {
  id: string
  kind: string
  actor: string
  status: string
  error_code: string | null
  decision_json: unknown
  ttft_ms: number | null
  total_ms: number | null
  tool_calls: ToolCall[]
}

/** §8：每則 AI 回答都查得到原因：判斷、工具、參數、結果、耗時 */
export function TracePanel({ conversationId }: { conversationId: string }) {
  const [runs, setRuns] = useState<Run[] | null>(null)

  async function load() {
    setRuns((await api<{ runs: Run[] }>(`/console/conversations/${conversationId}/trace`)).runs)
  }

  return (
    <details className="trace" onToggle={(e) => (e.currentTarget as HTMLDetailsElement).open && void load()}>
      <summary>追蹤（AI 的每次判斷和查詢）</summary>
      {runs?.length === 0 && <p className="hint">這段對話還沒有 AI 執行紀錄</p>}
      {runs?.map((r) => (
        <div key={r.id} className="trace-run">
          <strong>
            {r.kind}・{r.status}
            {r.error_code && `（${r.error_code}）`}
          </strong>
          <span className="hint">
            　第一個字 {r.ttft_ms ?? '—'} ms／總共 {r.total_ms ?? '—'} ms
          </span>
          {r.decision_json != null && <pre>{JSON.stringify(r.decision_json, null, 2)}</pre>}
          {r.tool_calls.map((t, i) => (
            <details key={i}>
              <summary>
                {t.tool}・{t.status}・{t.duration_ms} ms
              </summary>
              <pre>{JSON.stringify({ args: t.args_json, result: t.result_json }, null, 2)}</pre>
            </details>
          ))}
        </div>
      ))}
    </details>
  )
}
