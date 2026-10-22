import { CheckCircle2, Eye, EyeOff, KeyRound, LockKeyhole, LogOut, MailCheck, ShieldCheck } from 'lucide-react'
import { useId, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { apiFetch } from '../services/api/client'
import LoadingButton from '../components/LoadingButton'
import ChangeEmail from '../components/ChangeEmail'
import useOtpCooldown from '../hooks/useOtpCooldown'
import { clearOtpSession, readOtpSession, writeOtpSession } from '../utils/otpSession'
import { passwordPolicyError } from '../utils/validation'
import { useAuth } from '../context/AuthContext'

const OTP_SESSION_KEY = 'ic-laundry:account-password-otp'
const OTP_COOLDOWN_KEY = 'ic-laundry:account-password-otp-cooldown'
const ACCOUNT_TABS = [
  { id: 'password', label: 'Password', icon: ShieldCheck },
  { id: 'recovery-email', label: 'Recovery email', icon: MailCheck },
  { id: 'session', label: 'Session', icon: LogOut },
]

function tabFromHash() {
  const id = window.location.hash.replace('#account-', '')
  return ACCOUNT_TABS.some(tab => tab.id === id) ? id : ACCOUNT_TABS[0].id
}

function PasswordField({ label, value, onChange, visible, onToggle, placeholder, disabled }) {
  const fieldId = useId()
  return <div className="login-field">
    <label htmlFor={fieldId}>{label}</label>
    <div className="login-input-wrap">
      <LockKeyhole size={15} className="login-input-icon" />
      <input id={fieldId} className="login-input login-input-password" type={visible ? 'text' : 'password'} disabled={disabled} value={value} onChange={event => onChange(event.target.value)} minLength={12} placeholder={placeholder} autoComplete="new-password" required />
      <button type="button" className="login-eye-btn" disabled={disabled} onClick={onToggle} aria-label={visible ? `Hide ${label}` : `Show ${label}`}>
        {visible ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  </div>
}

export default function AccountSecurity() {
  const { signOut, user, staffName, branch, contactEmail } = useAuth()
  const navigate = useNavigate()
  const [savedRequest] = useState(() => readOtpSession(OTP_SESSION_KEY))
  const [newPassword, setNewPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [otp, setOtp] = useState('')
  const [otpStatus, setOtpStatus] = useState('idle')
  const [otpMessage, setOtpMessage] = useState('')
  const [destination, setDestination] = useState(() => savedRequest?.destination || '')
  const [recoveryEmailMissing, setRecoveryEmailMissing] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const [saving, setSaving] = useState(false)
  const [passwordChanged, setPasswordChanged] = useState(false)
  const [visible, setVisible] = useState({ next: false, confirmation: false })
  const cooldown = useOtpCooldown(OTP_COOLDOWN_KEY)
  // One tab is shown at a time; the URL hash keeps it linkable.
  const [activeTab, setActiveTab] = useState(tabFromHash)
  const selectTab = tabId => {
    setActiveTab(tabId)
    window.history.replaceState(window.history.state, '', `#account-${tabId}`)
  }

  async function requestCode() {
    setSendingCode(true)
    setRecoveryEmailMissing(false)
    try {
      const result = await apiFetch('/api/auth/password/otp', { method: 'POST' })
      setDestination(result.destination)
      writeOtpSession(OTP_SESSION_KEY, { destination: result.destination })
      cooldown.start(result.cooldownSeconds)
      setOtp(''); setOtpStatus('idle'); setOtpMessage(''); setNewPassword(''); setConfirmation('')
      toast.success(`Verification code sent to ${result.destination}`)
    } catch (error) {
      setRecoveryEmailMissing(error.data?.code === 'CONTACT_EMAIL_REQUIRED')
      if (error.data?.retryAfterSeconds) cooldown.start(error.data.retryAfterSeconds)
      toast.error(error.message)
    } finally {
      setSendingCode(false)
    }
  }

  async function verifyCode(code) {
    if (!/^\d{6}$/.test(code)) return
    setOtpStatus('checking'); setOtpMessage('')
    try {
      await apiFetch('/api/auth/password/otp/verify', { method: 'POST', body: JSON.stringify({ otp: code }) })
      setOtpStatus('valid')
    } catch (error) {
      setOtpStatus('invalid')
      setOtpMessage(/invalid verification code/i.test(error.message) ? 'OTP is wrong. Please try again.' : error.message)
    }
  }

  async function submit(event) {
    event.preventDefault()
    const policyError = passwordPolicyError(newPassword)
    if (policyError) return toast.error(policyError)
    if (newPassword !== confirmation) return toast.error('Passwords do not match.')
    if (otpStatus !== 'valid') return toast.error('Verify your OTP before setting a new password.')
    setSaving(true)
    try {
      await apiFetch('/api/auth/password', { method: 'PATCH', body: JSON.stringify({ newPassword, otp }) })
      clearOtpSession(OTP_SESSION_KEY)
      setPasswordChanged(true)
    } catch (error) {
      toast.error(error.message || 'Unable to change password.')
    } finally {
      setSaving(false)
    }
  }

  const flip = field => () => setVisible(state => ({ ...state, [field]: !state[field] }))
  const handleTabKeyDown = event => {
    const index = ACCOUNT_TABS.findIndex(tab => tab.id === activeTab)
    const steps = { ArrowDown: 1, ArrowRight: 1, ArrowUp: -1, ArrowLeft: -1 }
    let next = null
    if (event.key in steps) next = ACCOUNT_TABS[(index + steps[event.key] + ACCOUNT_TABS.length) % ACCOUNT_TABS.length]
    if (event.key === 'Home') next = ACCOUNT_TABS[0]
    if (event.key === 'End') next = ACCOUNT_TABS[ACCOUNT_TABS.length - 1]
    if (!next) return
    event.preventDefault()
    selectTab(next.id)
    document.getElementById(`account-tab-${next.id}`)?.focus()
  }
  return <div className="account-security-page settings-layout">
    <div className="settings-tabs" role="tablist" aria-label="Account sections" aria-orientation="vertical" onKeyDown={handleTabKeyDown}>
      {ACCOUNT_TABS.map(({ id, label, icon: Icon }) => (
        <button key={id} type="button" role="tab" id={`account-tab-${id}`} className="settings-tab" aria-selected={activeTab === id} aria-controls={`account-panel-${id}`} tabIndex={activeTab === id ? 0 : -1} onClick={() => selectTab(id)}>
          <Icon size={16} aria-hidden="true" /> {label}
        </button>
      ))}
    </div>
    <div className="settings-content">
    <section id="account-panel-password" role="tabpanel" aria-labelledby="account-tab-password" hidden={activeTab !== 'password'} className="card settings-section account-security-card">
      <header className="settings-section-header">
        <h3>Change password</h3>
        <p>Verify your identity with a one-time code sent to your contact email, then set a new password.</p>
      </header>
      <div className="settings-row settings-row-stacked"><div className="settings-password-form">
      <form onSubmit={submit} className="login-form account-security-form">
        <LoadingButton type="button" className="account-security-code-button" disabled={cooldown.remaining > 0} onClick={requestCode} loading={sendingCode} loadingLabel="Sending verification code…">
          <MailCheck size={16} /> {destination ? cooldown.label : 'Send verification code'}
        </LoadingButton>
        {cooldown.remaining > 0 && <p className="otp-cooldown-notice" role="status">{cooldown.message}</p>}
        {recoveryEmailMissing && <div className="otp-email-missing" role="alert">No recovery email is bound to your account. Open the <button type="button" className="login-forgot-password" onClick={() => selectTab('recovery-email')}>Recovery email</button> tab to add one before requesting an OTP.</div>}
        {destination && <div className="account-security-notice"><MailCheck size={16} /><span>Code sent to <strong>{destination}</strong>. It expires in 10 minutes.</span></div>}
        <div className="login-field" style={{ marginTop: 16 }}>
          <label htmlFor="account-security-otp">Email verification code</label>
          <div className="login-input-wrap">
            <KeyRound size={15} className="login-input-icon" />
            <input id="account-security-otp" autoComplete="one-time-code" spellCheck={false} className={`login-input account-security-otp otp-verification-input ${otpStatus}`} inputMode="numeric" maxLength={6} value={otp} disabled={!destination || saving || otpStatus === 'valid' || otpStatus === 'checking'} onChange={event => { const code = event.target.value.replace(/\D/g, ''); setOtp(code); setOtpStatus('idle'); setOtpMessage(''); if (code.length === 6) void verifyCode(code) }} placeholder="000000" aria-invalid={otpStatus === 'invalid'} required />
          </div>
          {otpStatus === 'checking' && <p className="otp-verification-checking" role="status">Checking OTP…</p>}
          {otpMessage && <p className="otp-verification-message" role="alert">{otpMessage}</p>}
        </div>
        {otpStatus === 'valid' && <div className="otp-verification-success" role="status">OTP verified. You can now set a new password.</div>}
        <PasswordField label="New password" value={newPassword} onChange={setNewPassword} visible={visible.next} onToggle={flip('next')} placeholder="Strong password" disabled={saving || otpStatus !== 'valid'} />
        <PasswordField label="Confirm new password" value={confirmation} onChange={setConfirmation} visible={visible.confirmation} onToggle={flip('confirmation')} placeholder="Re-enter your new password" disabled={saving || otpStatus !== 'valid'} />
        <LoadingButton type="submit" className="btn btn-primary" disabled={otpStatus !== 'valid'} loading={saving} loadingLabel="Changing password…"><LockKeyhole size={16} /> Change password</LoadingButton>
      </form>
      </div></div>
    </section>
    <div id="account-panel-recovery-email" role="tabpanel" aria-labelledby="account-tab-recovery-email" hidden={activeTab !== 'recovery-email'} className="settings-panel">
      <ChangeEmail onChanged={() => { clearOtpSession(OTP_SESSION_KEY); setOtp(''); setDestination(''); setOtpStatus('idle') }} />
    </div>
    <section id="account-panel-session" role="tabpanel" aria-labelledby="account-tab-session" hidden={activeTab !== 'session'} className="card settings-section">
      <header className="settings-section-header">
        <h3>Session</h3>
        <p>Sign out when you finish using a shared phone or computer.</p>
      </header>
      <div className="settings-row">
        <div className="settings-row-text"><span className="settings-row-label">Name</span></div>
        <div className="settings-row-control settings-row-value">{staffName || 'Staff account'}</div>
      </div>
      <div className="settings-row">
        <div className="settings-row-text"><span className="settings-row-label">Contact email</span></div>
        <div className="settings-row-control settings-row-value">{contactEmail || user?.email || 'No contact email'}</div>
      </div>
      {branch && <div className="settings-row">
        <div className="settings-row-text"><span className="settings-row-label">Branch</span></div>
        <div className="settings-row-control settings-row-value">{branch}</div>
      </div>}
      <footer className="settings-section-footer">
        <span>You’ll need your username and password to sign in again.</span>
        <button type="button" className="btn btn-danger" onClick={signOut}><LogOut size={16} /> Sign out</button>
      </footer>
    </section>
    </div>
    {passwordChanged && <div className="modal-overlay account-security-success-overlay" role="presentation">
      <section className="account-security-success-dialog" role="alertdialog" aria-modal="true" aria-labelledby="password-success-title">
        <span className="account-security-success-icon"><CheckCircle2 size={32} /></span>
        <h3 id="password-success-title">Password changed successfully</h3>
        <p>Your password was updated and your account is now using a fresh secure session.</p>
        <div className="account-security-success-note">For your protection, do not share your new password or verification code with anyone.</div>
        <button className="account-security-submit" onClick={() => navigate('/dashboard', { replace: true })}>Continue to dashboard</button>
      </section>
    </div>}
  </div>
}
