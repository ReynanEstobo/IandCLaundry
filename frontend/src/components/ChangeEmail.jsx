import { useState } from 'react'
import { CheckCircle2, Eye, EyeOff, MailCheck } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { apiFetch } from '../services/api/client'
import LoadingButton from './LoadingButton'
import useOtpCooldown from '../hooks/useOtpCooldown'
import { clearOtpSession, readOtpSession, writeOtpSession } from '../utils/otpSession'

const OTP_SESSION_KEY = 'ic-laundry:change-email-otp'
const OTP_COOLDOWN_KEY = 'ic-laundry:change-email-otp-cooldown'

export default function ChangeEmail({ onChanged }) {
  const { user, contactEmail, refreshProfile } = useAuth()
  const [savedChallenge] = useState(() => readOtpSession(OTP_SESSION_KEY))
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [visible, setVisible] = useState(false)
  const [challenge, setChallenge] = useState(() => savedChallenge?.challengeId && savedChallenge?.destination ? { challengeId: savedChallenge.challengeId, destination: savedChallenge.destination } : null)
  const [otp, setOtp] = useState('')
  const [otpStatus, setOtpStatus] = useState('idle')
  const [otpMessage, setOtpMessage] = useState('')
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [savedEmail, setSavedEmail] = useState('')
  const cooldown = useOtpCooldown(OTP_COOLDOWN_KEY)
  const current = savedEmail || contactEmail || (user?.email?.endsWith('.local') ? '' : user?.email)

  async function sendCode(event) {
    event.preventDefault()
    if (busy) return
    setBusy('send')
    setError('')
    try {
      const result = await apiFetch('/api/auth/email/otp', {
        method: 'POST', body: JSON.stringify({ newEmail: email, currentPassword: password }),
      })
      setChallenge(result)
      writeOtpSession(OTP_SESSION_KEY, { challengeId: result.challengeId, destination: result.destination })
      cooldown.start(result.cooldownSeconds)
      setOtp('')
      setOtpStatus('idle')
      setOtpMessage('')
      setPassword('')
    } catch (error) { if (error.data?.retryAfterSeconds) cooldown.start(error.data.retryAfterSeconds); setError(error.message) }
    finally { setBusy('') }
  }

  async function verifyOtp(code) {
    if (!challenge || !/^\d{6}$/.test(code)) return
    setBusy('verify')
    setOtpStatus('checking'); setOtpMessage(''); setError('')
    try {
      await apiFetch('/api/auth/email/otp/verify', { method: 'POST', body: JSON.stringify({ challengeId: challenge.challengeId, otp: code }) })
      setOtpStatus('valid')
    } catch (error) {
      setOtpStatus('invalid')
      setOtpMessage(/invalid verification code/i.test(error.message) ? 'OTP is wrong. Please try again.' : error.message)
    } finally { setBusy('') }
  }

  async function confirm(event) {
    event.preventDefault()
    if (busy || !challenge || otpStatus !== 'valid') return
    setBusy('confirm')
    setError('')
    try {
      const result = await apiFetch('/api/auth/email', {
        method: 'PATCH', body: JSON.stringify({ challengeId: challenge.challengeId, otp }),
      })
      setSavedEmail(result.contactEmail)
      setChallenge(null)
      clearOtpSession(OTP_SESSION_KEY)
      setEmail('')
      setOtp('')
      onChanged?.()
      await refreshProfile()
    } catch (error) { setError(error.message) }
    finally { setBusy('') }
  }

  return <section className="card settings-card change-email-card">
    <div className="settings-card-header">
      <div className="settings-card-icon blue"><MailCheck size={22} /></div>
      <div><h3>Change Bound Email</h3><p>Choose where you receive password verification and recovery codes.</p></div>
    </div>
    <div className="settings-info-row"><span className="settings-label">Bound email</span><span className="settings-value" style={{ overflowWrap: 'anywhere' }}>{current || 'No email bound'}</span></div>
    <p style={{ color: 'var(--text-secondary)', fontSize: 13, margin: '16px 0' }}>Confirm your current password, then verify a code sent to the new address. Your existing sign-in details stay the same.</p>
    {savedEmail && <div className="account-security-notice" role="status"><CheckCircle2 size={20} /><span>Email changed successfully. Future password codes will be sent to <strong>{savedEmail}</strong>. Request a fresh password code after this change.</span></div>}
    {error && <p role="alert" style={{ color: 'var(--danger, #b91c1c)' }}>{error}</p>}
    {cooldown.remaining > 0 && <p className="otp-cooldown-notice" role="status">{cooldown.message}</p>}
    {!challenge ? <form onSubmit={sendCode}>
      <div className="form-group"><label htmlFor="bound-email">New email address</label><input id="bound-email" className="form-control" type="email" autoComplete="email" maxLength={254} value={email} onChange={event => setEmail(event.target.value)} disabled={Boolean(busy)} required /></div>
      <div className="form-group"><label htmlFor="bound-email-password">Current password</label><div className="settings-input-wrapper">
        <input id="bound-email-password" className="form-control" type={visible ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} disabled={Boolean(busy)} style={{ paddingRight: 42 }} required />
        <button type="button" className="settings-eye-btn" aria-label={visible ? 'Hide password' : 'Show password'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={16} /> : <Eye size={16} />}</button>
      </div></div>
      <LoadingButton type="submit" className="btn btn-primary" disabled={cooldown.remaining > 0} loading={busy === 'send'} loadingLabel="Sending code…">{cooldown.remaining ? cooldown.label : 'Send code to new email'}</LoadingButton>
    </form> : <form onSubmit={confirm}>
      <div className="account-security-notice" role="status"><MailCheck size={18} /><span>Code sent to <strong>{challenge.destination}</strong>. Expires in 10 minutes; maximum five attempts.</span></div>
      <div className="form-group" style={{ marginTop: 16 }}><label htmlFor="bound-email-code">Verification code from new email</label><input id="bound-email-code" className={`form-control otp-verification-input ${otpStatus}`} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={otp} onChange={event => { const code = event.target.value.replace(/\D/g, ''); setOtp(code); setOtpStatus('idle'); setOtpMessage(''); if (code.length === 6) void verifyOtp(code) }} disabled={Boolean(busy) || otpStatus === 'valid'} aria-invalid={otpStatus === 'invalid'} required />{otpStatus === 'checking' && <p className="otp-verification-checking" role="status">Checking OTP…</p>}{otpMessage && <p className="otp-verification-message" role="alert">{otpMessage}</p>}</div>
      {otpStatus === 'valid' && <div className="otp-verification-success" role="status">OTP verified. You can now confirm the email change.</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
        <LoadingButton type="submit" className="btn btn-primary" disabled={otpStatus !== 'valid'} loading={busy === 'confirm'} loadingLabel="Updating email…">Confirm email change</LoadingButton>
        <button type="button" className="btn btn-secondary" disabled={Boolean(busy)} onClick={() => { clearOtpSession(OTP_SESSION_KEY); setChallenge(null); setOtp(''); setOtpStatus('idle'); setOtpMessage(''); setError('') }}>Change address / request another code</button>
      </div>
    </form>}
  </section>
}
