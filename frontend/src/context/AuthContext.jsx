import { createContext, useContext, useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase'
import { getStoredSession, restoreSession, startSessionMonitor } from '../services/api/client'
import { clearIdleNotice, idleStatus, noteIdleSignOut, startIdlePeriod } from '../services/api/idleTimeout'

const AuthContext = createContext({})
// The automatic sign-out waits at most this long for the server before
// showing the login page; the next visit finishes it if the server missed it.
const IDLE_SIGNOUT_WAIT_MS = 4000

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
    let lastAccount
    // The browser never sees tokens; the account and its forced
    // password-change state are what decide a profile reload.
    const applySession = incoming => {
      let session = incoming
      // A browser that was closed, asleep or offline for longer than the idle
      // limit opens signed out instead of reopening the account.
      if (session && idleStatus().state === 'expired') {
        noteIdleSignOut()
        void supabase.auth.signOut({ timeoutMs: IDLE_SIGNOUT_WAIT_MS })
        session = null
      }
      const account = session ? `${session.user?.id}:${Boolean(session.hc_must_change_password)}` : null
      if (!active || lastAccount === account) return
      lastAccount = account
      const u = session?.user ?? null
      setUser(u)
      fetchStaffRole(u).finally(() => { if (active) setLoading(false) })
    }
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => applySession(session))
    const stopMonitor = startSessionMonitor()
    // Every tab, including a duplicated one, asks the server which account
    // this browser is signed in to.
    restoreSession()
      .then(session => applySession(session))
      .catch(() => applySession(null))

    return () => {
      active = false
      profileVersion.current++
      subscription.unsubscribe()
      stopMonitor()
    }
  }, [])

  const signIn = async (email, password, remember) => {
    // The new hour starts before the session arrives, so a stale activity time
    // from an earlier visit cannot sign the account straight back out.
    startIdlePeriod()
    const { error } = await supabase.auth.signInWithPassword({ email, password, remember })
    return { error }
  }

  // `reason: 'idle'` is the automatic sign-out; the sign-in page then says why.
  // Clearing the session sends every signed-in page to /login (ProtectedRoute).
  const signOut = async ({ reason } = {}) => {
    if (reason === 'idle') {
      noteIdleSignOut()
      await supabase.auth.signOut({ timeoutMs: IDLE_SIGNOUT_WAIT_MS })
      return
    }
    clearIdleNotice()
    await supabase.auth.signOut()
  }

  return (
    <AuthContext.Provider value={{ user, role, staffName, branch, contactEmail, mustChangePassword, loading, signIn, signOut, refreshProfile: () => fetchStaffRole(user) }}>
      {children}
    </AuthContext.Provider>
  )
}
