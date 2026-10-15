import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import './index.css'
import AuthGate from './components/AuthGate.tsx'

// 移动端（iOS Safari / 钉钉 / 微信等）从 bfcache（往返缓存）恢复时强制刷新，避免登录跳回时展示旧版页面
if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      window.location.reload();
    }
  });
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthGate />
    </BrowserRouter>
  </StrictMode>,
)
