import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

// 注意:不使用 StrictMode —— TradingView widget 不是幂等创建,
// StrictMode 在开发环境的双重挂载会在初始化中途销毁第一个 widget,导致图表永远停在加载动画。
createRoot(document.getElementById('root')!).render(<App />)
