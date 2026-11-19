import { useEffect, useState } from 'react'
import { api, post } from '../api.ts'

type Settings = { support_demo: 'on' | 'off'; logistics_down: 'on' | 'off' }

/** demo 用：物流開關、物流故障。只有員工看得到；測試訂單在商店下 */
export function DemoPanel() {
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    api<Settings>('/console/demo').then(setSettings, () => setSettings(null))
  }, [])

  async function toggle(name: keyof Settings) {
    if (!settings) return
    setSettings(await post<Settings>('/console/demo/settings', { [name]: settings[name] === 'on' ? 'off' : 'on' }))
  }

  if (!settings) return null
  return (
    <details className="demo-panel">
      <summary>Demo 面板</summary>
      <label className="note-toggle">
        <input type="checkbox" checked={settings.support_demo === 'on'} onChange={() => toggle('support_demo')} /> 客服 demo 物流（貓砂、狗屋 20 分鐘）
      </label>
      <label className="note-toggle">
        <input type="checkbox" checked={settings.logistics_down === 'on'} onChange={() => toggle('logistics_down')} /> 物流故障
      </label>
    </details>
  )
}
