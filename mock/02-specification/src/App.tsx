import { Navigate, Route, Routes } from 'react-router-dom'
import { AudiencePage } from './pages/AudiencePage'
import { DemoPage } from './pages/DemoPage'

export default function App() {
  return (
    <Routes>
      <Route path="/demo" element={<DemoPage />} />
      <Route
        path="/grandfather"
        element={<AudiencePage audience="grandfather" />}
      />
      <Route path="/family" element={<AudiencePage audience="family" />} />
      <Route path="*" element={<Navigate to="/demo" replace />} />
    </Routes>
  )
}
