import { Outlet } from 'react-router-dom'
import { Sidebar } from './components/Sidebar'

export default function App() {
  return (
    <div className="h-full flex bg-bg text-text">
      <Sidebar />
      <main className="flex-1 overflow-hidden flex flex-col">
        <Outlet />
      </main>
    </div>
  )
}
