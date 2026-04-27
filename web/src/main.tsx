import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import App from './App'
import { Chat } from './components/Chat'
import { Today } from './components/Today'
import { Trends } from './components/Trends'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <Routes>
        <Route element={<App />}>
          <Route index element={<Chat />} />
          <Route path="today" element={<Today />} />
          <Route path="trends" element={<Trends />} />
        </Route>
      </Routes>
    </BrowserRouter>
  </React.StrictMode>,
)
