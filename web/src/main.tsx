import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import App from './App'
import { Today } from './components/Today'
import { Trends } from './components/Trends'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<Today />} />
          <Route path="trends" element={<Trends />} />
          {/* legacy /chat → home */}
          <Route path="chat" element={<Navigate to="/" replace />} />
          <Route path="today" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
