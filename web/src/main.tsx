import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { initTheme } from './lib/theme'
import { initSheetGestures } from './lib/sheet'
import App from './App.tsx'

initTheme()
initSheetGestures()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// 应用挂载后淡出启动画面
requestAnimationFrame(() => {
  const boot = document.getElementById('boot');
  if (boot) {
    boot.classList.add('boot-out');
    window.setTimeout(() => boot.remove(), 400);
  }
});
