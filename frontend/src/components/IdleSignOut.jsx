import { Clock, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { IDLE_LIMIT_LABEL, idleStatus, recordActivity } from '../services/api/idleTimeout'
import useEscapeToClose from './useEscapeToClose'

const ACTIVITY_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll']

function formatCountdown(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

/**
 * Watches a signed-in browser for activity. After an hour with no clicks, key
 * presses, scrolling or touches in any tab, it warns for a minute and then
 * signs the account out everywhere.
 */
export default function IdleSignOut() {
  const { user, signOut } = useAuth()
  const [secondsLeft, setSecondsLeft] = useState(null)
  const warningOpen = useRef(false)
  const signOutRef = useRef(signOut)
  useEffect(() => { signOutRef.current = signOut })

  useEffect(() => {
    if (!user) {
      warningOpen.current = false
      setSecondsLeft(null)
      return undefined
    }
    let signingOut = false
    const check = () => {
      const status = idleStatus()
      if (status.state === 'expired') {
        if (signingOut) return
        signingOut = true
        warningOpen.current = false
        setSecondsLeft(null)
        void signOutRef.current({ reason: 'idle' })
        return
      }
      warningOpen.current = status.state === 'warning'
      setSecondsLeft(warningOpen.current ? status.secondsLeft : null)
    }
    // While the warning is up, only "Stay signed in" (or using another tab)
    // keeps the session; a stray mouse movement does not.
    const onActivity = () => { if (!warningOpen.current) recordActivity() }
    const onVisible = () => { if (!document.hidden) check() }

    // Check the time away first, so opening a stale tab cannot restart the hour.
    check()
    if (!signingOut) recordActivity()
    ACTIVITY_EVENTS.forEach(name => window.addEventListener(name, onActivity, { capture: true, passive: true }))
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', check)
    window.addEventListener('storage', check)
    const timer = window.setInterval(check, 1000)
    return () => {
      ACTIVITY_EVENTS.forEach(name => window.removeEventListener(name, onActivity, { capture: true }))
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', check)
      window.removeEventListener('storage', check)
      window.clearInterval(timer)
    }
  }, [user])

  const open = secondsLeft !== null
  const staySignedIn = () => {
    recordActivity(Date.now(), { force: true })
    warningOpen.current = false
    setSecondsLeft(null)
  }
  useEscapeToClose(open, staySignedIn)
  if (!open) return null

  return (
    <div className="modal-overlay confirm-dialog-overlay" role="presentation" onMouseDown={staySignedIn}>
      <section
        className="confirm-dialog confirm-dialog-primary idle-signout-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="idle-signout-title"
        aria-describedby="idle-signout-message"
        onMouseDown={event => event.stopPropagation()}
      >
        <header className="confirm-dialog-header">
          <span className="confirm-dialog-icon"><Clock size={22} /></span>
          <div><h3 id="idle-signout-title">Are you still there?</h3></div>
          <button className="btn-icon" aria-label="Stay signed in" onClick={staySignedIn}><X size={20} /></button>
        </header>
        <div className="confirm-dialog-body" id="idle-signout-message">
          There has been no activity for almost {IDLE_LIMIT_LABEL}. For security, you will be signed out in{' '}
          <strong className="idle-signout-countdown">{formatCountdown(secondsLeft)}</strong>.
        </div>
        <footer className="confirm-dialog-footer">
          <button className="btn btn-secondary" onClick={() => void signOut()}>Sign out now</button>
          <button className="btn btn-primary confirm-dialog-action" onClick={staySignedIn} autoFocus>Stay signed in</button>
        </footer>
      </section>
    </div>
  )
}
