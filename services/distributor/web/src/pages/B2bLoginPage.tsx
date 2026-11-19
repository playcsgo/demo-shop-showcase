import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api.ts'
import { type B2bMe, useB2b } from './B2bApp.tsx'

export function B2bLoginPage() {
  const { setMe } = useB2b()
  const navigate = useNavigate()
  const [email, setEmail] = useState('pacific-manager@example.test')
  const [password, setPassword] = useState('0204')
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    try {
      setMe((await api<{ user: B2bMe }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) })).user)
      navigate('/')
    } catch {
      setError('帳號或密碼錯誤')
    }
  }

  return (
    <form className="card narrow" onSubmit={submit}>
      <h1>經銷商登入</h1>
      <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label>密碼<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {error && <p className="error">{error}</p>}
      <button className="primary">登入</button>
      <p className="hint">帳號由負責的業務開通；忘記密碼請聯絡業務。</p>
    </form>
  )
}
