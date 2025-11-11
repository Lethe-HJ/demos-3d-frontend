import './App.css'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import LayoutPage from './Layout/Index'
import Home from './pages/Home'

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<LayoutPage />}>
          <Route index element={<Home />} />
        </Route>
      </Routes>
    </BrowserRouter>
  )
}

export default App
