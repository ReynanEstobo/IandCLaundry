import { Eye, EyeOff, KeyRound, LockKeyhole, MailCheck, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import LoadingButton from '../components/LoadingButton'
import { apiFetch } from '../services/api/client'
import useOtpCooldown from '../hooks/useOtpCooldown'
import { clearOtpSession, readOtpSession, writeOtpSession } from '../utils/otpSession'
import { passwordPolicyError } from '../utils/validation'

const OTP_SESSION_KEY = 'ic-laundry:forgot-password-otp'
const OTP_COOLDOWN_KEY = 'ic-laundry:forgot-password-otp-cooldown'

function PasswordInput({ label, value, onChange, visible, onToggle, disabled }) {
  return <div className="login-field">
    <label>{label}</label>
    <div className="login-input-wrap">
      <LockKeyhole size={15} className="login-input-icon" />
      <input className="login-input login-input-password" type={visible ? 'text' : 'password'} disabled={disabled} value={value} onChange={event => onChange(event.target.value)} minLength={12} placeholder="Strong password" autoComplete="new-password" required />
      <button type="button" className="login-eye-btn" disabled={disabled} onClick={onToggle}>{visible ? <EyeOff size={15} /> : <Eye size={15} />}</button>
    </div>
  </div>
}

export default function ForgotPassword() {
  const navigate = useNavigate()
  const [savedRequest] = useState(() => readOtpSession(OTP_SESSION_KEY))
  const [identifier, setIdentifier] = useState(() => savedRequest?.identifier || '')
  const [codeRequested, setCodeRequested] = useState(() => Boolean(savedRequest?.identifier))
  const [otp, setOtp] = useState('')
  const [otpStatus, setOtpStatus] = useState('idle')
  const [otpMessage, setOtpMessage] = useState('')
  const [password, setPassword] = useState('')
  const [confirmation, setConfirmation] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [loading, setLoading] = useState(false)
  const cooldown = useOtpCooldown(OTP_COOLDOWN_KEY)
  const verified = otpStatus === 'valid'

  async function requestCode() {
    if (!identifier.trim()) return toast.error('Enter your Staff ID, username, or email.')
    setLoading(true)
    try {
      const result = await apiFetch('/api/auth/forgot-password/otp', { method: 'POST', body: JSON.stringify({ identifier }) })
      cooldown.start(result.cooldownSeconds)
      writeOtpSession(OTP_SESSION_KEY, { identifier: identifier.trim() })
      setCodeRequested(true)
      setOtp(''); setOtpStatus('idle'); setOtpMessage(''); setPassword(''); setConfirmation('')
      toast.success(result.message || 'If an active account has a recovery email, a verification code has been sent.')
    } catch (error) { if (error.data?.retryAfterSeconds) cooldown.start(error.data.retryAfterSeconds); toast.error(error.message) } finally { setLoading(false) }
  }

  async function verifyOtp(code) {
    if (!/^\d{6}$/.test(code)) return
    setOtpStatus('checking'); setOtpMessage('')
    try {
      await apiFetch('/api/auth/forgot-password/otp/verify', { method: 'POST', body: JSON.stringify({ identifier, otp: code }) })
      setOtpStatus('valid')
    } catch (error) {
      setOtpStatus('invalid')
      setOtpMessage(/invalid verification code/i.test(error.message) ? 'OTP is wrong. Please try again.' : error.message)
    }
  }

  async function submit(event) {
    event.preventDefault()
    if (!verified) return toast.error('Verify your OTP before setting a new password.')
    const policyError = passwordPolicyError(password, identifier)
    if (policyError) return toast.error(policyError)
    if (password !== confirmation) return toast.error('Passwords do not match.')
    setLoading(true)
    try {
      await apiFetch('/api/auth/forgot-password', { method: 'PATCH', body: JSON.stringify({ identifier, otp, newPassword: password }) })
      clearOtpSession(OTP_SESSION_KEY)
      toast.success('Password reset successfully. You can now sign in.')
      navigate('/login', { replace: true })
    } catch (error) { toast.error(error.message) } finally { setLoading(false) }
  }

  const updateOtp = value => {
    const code = value.replace(/\D/g, '')
    setOtp(code); setOtpStatus('idle'); setOtpMessage('')
    if (code.length === 6) void verifyOtp(code)
  }
  const locked = loading || !verified
  return <main className="login-page-wrapper"><section className="login-right-panel" style={{ width: '100%', minHeight: '100vh' }}><div className="login-form-wrapper"><div className="login-card-enhanced"><div className="login-card-header"><div className="login-card-icon"><ShieldCheck size={24} /></div><div><h2>Reset your password</h2><p>Verify your contact email before setting a new password.</p></div></div><form onSubmit={submit} className="login-form"><div className="login-field"><label>Account ID, username, or email</label><div className="login-input-wrap"><KeyRound size={15} className="login-input-icon" /><input className="login-input" value={identifier} disabled={codeRequested || loading} onChange={event => setIdentifier(event.target.value)} placeholder="e.g. IC-STAFF-AB12CD34" required /></div></div><LoadingButton type="button" className="login-submit-btn" disabled={loading || cooldown.remaining > 0} onClick={requestCode} loading={loading} loadingLabel="Sending...">{codeRequested ? cooldown.label : <><MailCheck size={16} /> Send verification code</>}</LoadingButton>{cooldown.remaining > 0 && <p className="otp-cooldown-notice" role="status">{cooldown.message}</p>}{codeRequested && <p className="otp-verification-checking" role="status">If this account has a recovery email, check its inbox for the code. Otherwise, contact an administrator.</p>}{codeRequested && <><div className="login-field"><label>Email verification code</label><div className="login-input-wrap"><KeyRound size={15} className="login-input-icon" /><input className={`login-input otp-verification-input ${otpStatus}`} inputMode="numeric" maxLength={6} disabled={loading || verified || otpStatus === 'checking'} value={otp} onChange={event => updateOtp(event.target.value)} placeholder="6-digit code" aria-invalid={otpStatus === 'invalid'} required /></div>{otpStatus === 'checking' && <p className="otp-verification-checking" role="status">Checking OTP…</p>}{otpMessage && <p className="otp-verification-message" role="alert">{otpMessage}</p>}</div>{verified && <div className="otp-verification-success" role="status">OTP verified. You can now set a new password.</div>}<PasswordInput label="New password" value={password} onChange={setPassword} visible={showPassword} onToggle={() => setShowPassword(value => !value)} disabled={locked} /><PasswordInput label="Confirm new password" value={confirmation} onChange={setConfirmation} visible={showConfirmation} onToggle={() => setShowConfirmation(value => !value)} disabled={locked} /><LoadingButton type="submit" className="login-submit-btn" disabled={!verified} loading={loading} loadingLabel="Resetting...">Reset password</LoadingButton></>}<div className="login-card-footer"><Link to="/login">Back to sign in</Link></div></form></div></div></section></main>
}
