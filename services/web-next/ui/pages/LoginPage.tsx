'use client'

import { useState } from 'react'
import { useNavigate, useSearchParams } from '@/ui/router.tsx'
import { api } from '../api.ts'
import { useMe } from '@/ui/shell.tsx'
import { Photo } from '../components/Photo.tsx'
import { PHOTOS } from '../photos.ts'

export function LoginPage() {
  const { setMe } = useMe()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [email, setEmail] = useState('alice@example.test')
  const [password, setPassword] = useState('0204')
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    try {
      setMe(await api('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }))
      const next = params.get('next') // 客服對話框帶來的：登入完回到原本那頁；只收站內路徑
      navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : '/me')
    } catch {
      setError('帳號或密碼錯誤')
    }
  }

  return (
    <div className="login">
      <div className="photo"><Photo photo={PHOTOS.kitten} eager /></div>
      <form onSubmit={submit}>
        <h1>登入</h1>
        <label>Email<input value={email} onChange={(e) => setEmail(e.target.value)} /></label>
        <label>密碼<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></label>
        {error && <p className="error">{error}</p>}
        <button className="primary">登入</button>
        <p className="hint">登入後瀏覽器只拿到 httpOnly 的 session cookie，打開 DevTools 執行 <code>document.cookie</code> 也看不到它。</p>
      </form>
    </div>
  )
}
