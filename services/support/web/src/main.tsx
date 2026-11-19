import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import { ConsolePage } from './pages/ConsolePage.tsx'
import './index.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        {/* 客戶的對話框在商店裡（AIC-018），這裡只剩控制台 */}
        <Route path="/" element={<Navigate to="/console" replace />} />
        <Route path="/console" element={<ConsolePage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
)
