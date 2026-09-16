import { createContext, useContext, useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { getStoredSession, refreshRememberedSession, startSessionMonitor } from '../services/api/client'

const AuthContext = createContext({})

export const useAuth = () => useContext(AuthContext)

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null)
  const [role, setRole] = useState(null)
  const [staffName, setStaffName] = useState(null)
  const [branch, setBranch] = useState(null)
  const [contactEmail, setContactEmail] = useState(null)
  const [mustChangePassword, setMustChangePassword] = useState(false)
  const [loading, setLoading] = useState(true)
  const profileVersion = useRef(0)

  async function fetchStaffRole(authUser) {
    const version = ++profileVersion.current
    if (!authUser) { setRole(null); setStaffName(null); setBranch(null); setContactEmail(null); setMustChangePassword(false); return }
    // The API intentionally blocks every normal data endpoint until a
    // provisioned staff member changes their temporary password.  Use the
    // signed-in session flag first, otherwise this profile request would be
    // rejected and the required-password screen would never appear.
    if (getStoredSession()?.hc_must_change_password) {
      setRole('staff')
      setStaffName(null)
      setBranch(null)
      setContactEmail(null)
      setMustChangePassword(true)
      return
    }
    const { data } = await supabase
      .from('staff')
      .select('role, full_name, branch, contact_email, must_change_password')
      .eq('auth_id', authUser.id)
      .maybeSingle()
    if (version !== profileVersion.current) return
    if (data) {
      setRole(String(data.role || 'unassigned').toLowerCase())
      setStaffName(data.full_name)
      setBranch(data.branch || null)
      setContactEmail(data.contact_email || null)
      setMustChangePassword(Boolean(data.must_change_password))
    } else {
      // No staff record — treat as admin (for seed user / owner)
      setRole('unassigned')
      setStaffName(null)
      setBranch(null)
      setContactEmail(null)
      setMustChangePassword(false)
    }
  }

  useEffect(() => {
    let active = true
    let lastToken
    const applySession = session => {
      if (!active || lastToken === (session?.access_token || null)) return
      lastToken = session?.access_token || null
      const u = session?.user ?? null
      setUser(u)
      fetchStaffRole(u).finally(() => { if (active) setLoading(false) })
    }
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => applySession(session))
    const stopMonitor = startSessionMonitor()
    const existingSession = getStoredSession()
    if (existingSession) applySession(existingSession)
    else {
      refreshRememberedSession()
        .then(session => applySession(session))
        .catch(() => applySession(null))
    }

    return () => {
      active = false
      profileVersion.current++
      subscription.unsubscribe()
      stopMonitor()
    }
  }, [])

  const signIn = async (email, password, remember) => {
    const { error } = await supabase.auth.signInWithPassword({ email, password, remember })
    return { error }
  }

  const signOut = async () => {
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ user, role, staffName, branch, contactEmail, mustChangePassword, loading, signIn, signOut, refreshProfile: () => fetchStaffRole(user) }}>
      {children}
    </AuthContext.Provider>
  )
}
