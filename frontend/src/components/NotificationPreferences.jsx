import toast from 'react-hot-toast'
import { useAuth } from '../context/AuthContext'
import useToastPreference from '../hooks/useToastPreference'

// "Notifications and display": each person's own on-screen preferences on
// this browser. Shown in Settings for administrators and in Account Security
// for staff. Used inside a tab panel <section>.
export default function NotificationPreferences({ idPrefix = 'notifications' }) {
  const { user } = useAuth()
  const { enabled, setPreference } = useToastPreference(user?.id)
  const labelId = `${idPrefix}-notifications-label`

  // The switch always says what it did. Both messages share one id, so
  // switching quickly replaces the message instead of stacking two that
  // contradict each other. "Off" is a plain notice, which the setting never
  // hides; "on" is a confirmation, shown because confirmations are now on.
  const toggle = () => {
    const next = !enabled
    setPreference(next)
    if (next) toast.success('Pop-up confirmations are on.', { id: 'toast-preference', icon: undefined })
    else toast('Pop-up confirmations are off. Errors and warnings will still show.', { id: 'toast-preference', icon: '🔕' })
  }

  return (
    <>
      <header className="settings-section-header">
        <h3 id={`${idPrefix}-notifications-title`}>Notifications and display</h3>
        <p>Your own on-screen preferences on this browser. They do not change anyone else&apos;s screen.</p>
      </header>
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label" id={labelId}>Action notifications</span>
          <p>Show pop-up confirmations for completed actions. Errors and warnings always show.</p>
        </div>
        <div className="settings-row-control">
          <button
            type="button"
            role="switch"
            className={`settings-toggle ${enabled ? 'active' : ''}`}
            onClick={toggle}
            aria-checked={enabled}
            aria-labelledby={labelId}
          >
            <div className="settings-toggle-knob" />
          </button>
        </div>
      </div>
      <div className="settings-row">
        <div className="settings-row-text">
          <span className="settings-row-label">Theme</span>
          <p>Use the moon or sun button in the page header to change the theme for only your account on this browser.</p>
        </div>
      </div>
      <p className="settings-auto-save-status" role="status">
        Notification changes are saved automatically for your account on this browser.
      </p>
    </>
  )
}
