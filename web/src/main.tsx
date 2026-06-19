import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom'
import App from './App'
import { AuthGate } from './components/AuthGate'
import { Dashboards } from './components/Dashboards'
import { Today } from './components/Today'
import { TrainingPlan } from './components/TrainingPlan'
import { Trends } from './components/Trends'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthGate>
        <Routes>
          <Route element={<App />}>
            <Route index element={<Today />} />
            <Route path="plan" element={<TrainingPlan />} />
            <Route path="trends" element={<Trends />} />
            <Route path="dashboards" element={<Dashboards />} />
            {/* legacy /chat → home */}
            <Route path="chat" element={<Navigate to="/" replace />} />
            <Route path="today" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </AuthGate>
    </BrowserRouter>
  </React.StrictMode>,
)
