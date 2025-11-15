import { Route, Routes } from 'react-router-dom'
import LayoutPage from '../Layout/Index'
import Home from '../pages/Home'
import SurfaceNetsDemo1 from '../pages/SurfaceNets'

const AppRoutes = () => (
  <Routes>
    <Route path="/" element={<LayoutPage />}>
      <Route index element={<Home />} />
      <Route path="surface-nets" element={<SurfaceNetsDemo1 />} />
    </Route>
  </Routes>
)

export default AppRoutes

