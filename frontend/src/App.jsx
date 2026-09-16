import { lazy, Suspense, useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { Toaster } from 'react-hot-toast'
import { AuthProvider, useAuth } from './context/AuthContext'
import Layout from './components/Layout'
import { AppErrorBoundary, PageLoader } from './components/AsyncState'

// Page modules (and their data effects) are loaded only after their route opens.
const LandingPage = lazy(() => import('./pages/LandingPage'))
const Login = lazy(() => import('./pages/Login'))
const ForgotPassword = lazy(() => import('./pages/ForgotPassword'))
const ActivatePassword = lazy(() => import('./pages/ActivatePassword'))
const AccountSecurity = lazy(() => import('./pages/AccountSecurity'))
const Dashboard = lazy(() => import('./pages/Dashboard'))
const Orders = lazy(() => import('./pages/Orders'))
const Customers = lazy(() => import('./pages/Customers'))
const Inventory = lazy(() => import('./pages/Inventory'))
const Analytics = lazy(() => import('./pages/Analytics'))
const SMS = lazy(() => import('./pages/SMS'))
const Settings = lazy(() => import('./pages/Settings'))
const Staff = lazy(() => import('./pages/Staff'))
const StaffDashboard = lazy(() => import('./pages/StaffDashboard'))
const AuditLog = lazy(() => import('./pages/RecycleBin'))

function ProtectedRoute({ children }) {
  const { user, mustChangePassword, loading } = useAuth()
  if (loading) return <div className="loading-spinner"><div className="spinner" /></div>
  if (!user) return <Navigate to="/login" replace />
  if (mustChangePassword) return <Navigate to="/activate-password" replace />
  return children
}

function AdminRoute({ children }) {
  const { role, loading } = useAuth()
  if (loading) return <div className="loading-spinner"><div className="spinner" /></div>
  if (role !== 'admin') return <Navigate to="/dashboard" />
  return children
}

function StaffSecurityRoute() {
  const { role, loading } = useAuth()
  if (loading) return <PageLoader />
  return role === 'admin' ? <Navigate to="/dashboard/settings" replace /> : <AccountSecurity />
}

function DashboardSwitch() {
  const { role } = useAuth()
  return role === 'staff' ? <StaffDashboard /> : <Dashboard />
}

function AppRoutes() {
  const { user, mustChangePassword, loading } = useAuth()

  if (loading) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="spinner" />
      </div>
    )
  }

  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
      <Route path="/" element={user ? <Navigate to={mustChangePassword ? "/activate-password" : "/dashboard"} /> : <LandingPage />} />
      <Route path="/login" element={user ? <Navigate to={mustChangePassword ? "/activate-password" : "/dashboard"} /> : <Login />} />
      <Route path="/forgot-password" element={user ? <Navigate to="/dashboard" /> : <ForgotPassword />} />
      <Route path="/activate-password" element={user && mustChangePassword ? <ActivatePassword /> : <Navigate to={user ? "/dashboard" : "/login"} />} />
      <Route path="/dashboard" element={<ProtectedRoute><Layout /></ProtectedRoute>}>
        <Route index element={<DashboardSwitch />} />
        <Route path="orders" element={<Orders />} />
        <Route path="customers" element={<Customers />} />
        <Route path="inventory" element={<Inventory />} />
        <Route path="change-password" element={<StaffSecurityRoute />} />
        <Route path="analytics" element={<AdminRoute><Analytics /></AdminRoute>} />
        <Route path="sms" element={<AdminRoute><SMS /></AdminRoute>} />
        <Route path="staff" element={<AdminRoute><Staff /></AdminRoute>} />
        <Route path="settings" element={<AdminRoute><Settings /></AdminRoute>} />
        <Route path="audit-log" element={<AdminRoute><AuditLog /></AdminRoute>} />
        <Route path="recycle-bin" element={<Navigate to="/dashboard/audit-log" replace />} />
      </Route>
      </Routes>
    </Suspense>
  )
}

// Tables can overflow on smaller screens. Touch devices already swipe them
// naturally; this gives mouse users the same click-and-drag behaviour.
function TableMouseDragScroll() {
  useEffect(() => {
    let activeTable = null
    let startX = 0
    let startScrollLeft = 0
    let dragged = false
    let suppressClick = false

    const isInteractive = (target) => target.closest('a, button, input, select, textarea, label, [role="button"]')

    const onMouseDown = (event) => {
      if (event.button !== 0 || isInteractive(event.target)) return
      const table = event.target.closest('.table-wrapper')
      if (!table || table.scrollWidth <= table.clientWidth) return

      activeTable = table
      startX = event.clientX
      startScrollLeft = table.scrollLeft
      dragged = false
    }

    const onMouseMove = (event) => {
      if (!activeTable) return
      const distance = event.clientX - startX
      if (Math.abs(distance) > 3) {
        dragged = true
        activeTable.classList.add('is-mouse-dragging')
        activeTable.scrollLeft = startScrollLeft - distance
        event.preventDefault()
      }
    }

    const onMouseUp = () => {
      if (!activeTable) return
      activeTable.classList.remove('is-mouse-dragging')
      suppressClick = dragged
      activeTable = null
      if (suppressClick) {
        window.setTimeout(() => { suppressClick = false }, 0)
      }
    }

    const onClick = (event) => {
      if (suppressClick) {
        event.preventDefault()
        event.stopPropagation()
      }
    }

    document.addEventListener('mousedown', onMouseDown)
    document.addEventListener('mousemove', onMouseMove)
    document.addEventListener('mouseup', onMouseUp)
    document.addEventListener('click', onClick, true)
    return () => {
      document.removeEventListener('mousedown', onMouseDown)
      document.removeEventListener('mousemove', onMouseMove)
      document.removeEventListener('mouseup', onMouseUp)
      document.removeEventListener('click', onClick, true)
    }
  }, [])

  return null
}

export default function App() {
  return (
    <AppErrorBoundary>
    <AuthProvider>
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: '#ffffff',
            color: '#111827',
            border: '1px solid #e5e7eb',
            borderRadius: '10px',
            boxShadow: '0 4px 16px rgba(0,0,0,0.08)',
            fontSize: '14px',
          },
        }}
      />
      <TableMouseDragScroll />
      <AppRoutes />
    </AuthProvider>
    </AppErrorBoundary>
  )
}
