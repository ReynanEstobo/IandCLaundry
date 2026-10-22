import { Eye, EyeOff, KeyRound, LockKeyhole, MailCheck, ShieldCheck } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import LoadingButton from '../components/LoadingButton'
import { apiFetch } from '../services/api/client'
import useOtpCooldown from '../hooks/useOtpCooldown'
import { clearOtpSession, readOtpSession, writeOtpSession } from '../utils/otpSession'
import { passwordPolicyError } from '../utils/validation'

const OTP_SESSION_KEY = 'ic-laundry:forgot-password-otp'
const OTP_COOLDOWN_KEY = 'ic-laundry:forgot-password-otp-cooldown'

function PasswordInput({ label, value, onChange, visible, onToggle, disabled, hint }) {
  const id = useId()
  return <div className="login-field">
    <label htmlFor={id}>{label}</label>
    <div className="login-input-wrap">
      <LockKeyhole size={15} className="login-input-icon" />
      <input id={id} aria-describedby={hint ? `${id}-hint` : undefined} className="login-input login-input-password" type={visible ? 'text' : 'password'} disabled={disabled} value={value} onChange={event => onChange(event.target.value)} minLength={12} placeholder="Strong password" autoComplete="new-password" required />
      <button type="button" className="login-eye-btn" disabled={disabled} onClick={onToggle} aria-label={`${visible ? 'Hide' : 'Show'} ${label.toLowerCase()}`}>{visible ? <EyeOff size={15} /> : <Eye size={15} />}</button>
    </div>
    {hint && <p id={`${id}-hint`} className="auth-hint">{hint}</p>}
  </div>
}

const RESET_STEPS = ['Username', 'Verify code', 'New password']

export default function ForgotPassword() {
  const navigate = useNavigate()
  const identifierInput = useRef(null)
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
    if (!identifier.trim()) return toast.error('Enter your username.')
    setLoading(true)
    try {
      const result = await apiFetch('/api/auth/forgot-password/otp', { method: 'POST', body: JSON.stringify({ identifier }) })
      cooldown.start(result.cooldownSeconds)
      writeOtpSession(OTP_SESSION_KEY, { identifier: identifier.trim() })
      setCodeRequested(true)
      setOtp(''); setOtpStatus('idle'); setOtpMessage(''); setPassword(''); setConfirmation('')
      toast.success(result.message || 'If this username belongs to an active account, a verification code has been sent to its recovery email.')
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
  const changeIdentifier = () => {
    clearOtpSession(OTP_SESSION_KEY)
    cooldown.clear()
    setIdentifier('')
    setCodeRequested(false)
    setOtp('')
    setOtpStatus('idle')
    setOtpMessage('')
    setPassword('')
    setConfirmation('')
    window.requestAnimationFrame(() => identifierInput.current?.focus())
  }
  const locked = loading || !verified
  // Display only: which of the three steps the person is on.
  const step = verified ? 3 : codeRequested ? 2 : 1
  const stepDescription = {
    1: 'Enter your username. We’ll send a verification code to the recovery email on that account.',
    2: 'Enter the 6-digit code from the recovery email linked to this username.',
    3: 'Choose a new password. You’ll sign in with it from now on.',
  }[step]
  return <main className="auth-page">
    <div className="auth-shell">
      <div className="auth-brand">
        <img src="/assets/Rectangle.png" width={1024} height={1024} alt="" />
        <span>I&amp;C Laundry</span>
      </div>
      <section className="auth-card" aria-labelledby="forgot-password-title">
        <ol className="auth-steps" aria-label={`Step ${step} of ${RESET_STEPS.length}`}>
          {RESET_STEPS.map((label, index) => (
            <li
              key={label}
              className={`auth-step ${index + 1 < step ? 'is-done' : ''} ${index + 1 === step ? 'is-current' : ''}`}
              aria-current={index + 1 === step ? 'step' : undefined}
            >
              {label}
            </li>
          ))}
        </ol>
        <header className="auth-card-header">
          <h1 id="forgot-password-title">Reset your password</h1>
          <p>{stepDescription}</p>
        </header>
        <form onSubmit={submit} className={`login-form forgot-password-form ${verified ? 'is-verified' : codeRequested ? 'is-code-requested' : 'is-username-entry'}`}>
          {!codeRequested && <div className="login-field">
            <label htmlFor="forgot-password-identifier">Username</label>
            <div className="login-input-wrap"><KeyRound size={15} className="login-input-icon" /><input autoComplete="username" spellCheck={false} id="forgot-password-identifier" ref={identifierInput} className="login-input" value={identifier} disabled={loading} onChange={event => setIdentifier(event.target.value)} placeholder="Enter your username" required /></div>
          </div>}
          {(!codeRequested || !verified) && <>
            {codeRequested && <div className="forgot-password-account-summary"><span>Recovery requested for</span><strong>{identifier}</strong></div>}
            <LoadingButton type="button" className="login-submit-btn forgot-password-action" disabled={loading || cooldown.remaining > 0} onClick={requestCode} loading={loading} loadingLabel="Sending…">{codeRequested ? cooldown.label : <><MailCheck size={16} /> Send verification code</>}</LoadingButton>
          </>}
          {codeRequested && !verified && <>
            <p className="forgot-password-status" role="status">If this username belongs to an active account, its recovery email should receive a code. Check spam too.</p>
            <button type="button" className="login-forgot-password forgot-password-change-identifier" disabled={loading} onClick={changeIdentifier}>Use a different username</button>
            <div className="login-field"><label htmlFor="forgot-password-code">Email verification code</label><div className="login-input-wrap"><KeyRound size={15} className="login-input-icon" /><input id="forgot-password-code" autoComplete="one-time-code" className={`login-input otp-verification-input ${otpStatus}`} inputMode="numeric" maxLength={6} disabled={loading || verified || otpStatus === 'checking'} value={otp} onChange={event => updateOtp(event.target.value)} placeholder="6-digit code" aria-invalid={otpStatus === 'invalid'} required /></div>{otpStatus === 'checking' && <p className="otp-verification-checking" role="status">Checking OTP…</p>}{otpMessage && <p className="otp-verification-message" role="alert">{otpMessage}</p>}</div>
          </>}
          {verified && <>
            <div className="otp-verification-success forgot-password-verified" role="status"><ShieldCheck size={18} /> Code verified for <strong>{identifier}</strong></div>
            <PasswordInput label="New password" value={password} onChange={setPassword} visible={showPassword} onToggle={() => setShowPassword(value => !value)} disabled={locked} hint="12–128 characters, with an uppercase letter, a lowercase letter, a number, and a symbol. No spaces, and not your username." />
            <PasswordInput label="Confirm new password" value={confirmation} onChange={setConfirmation} visible={showConfirmation} onToggle={() => setShowConfirmation(value => !value)} disabled={locked} />
            <LoadingButton type="submit" className="login-submit-btn forgot-password-action" disabled={!verified || loading} loading={loading} loadingLabel="Resetting…">Reset password</LoadingButton>
            <button type="button" className="login-forgot-password forgot-password-change-identifier" disabled={loading} onClick={changeIdentifier}>Use a different username</button>
          </>}
          <div className="login-card-footer"><Link to="/login">Back to sign in</Link></div>
        </form>
      </section>
      <p className="auth-footnote"><ShieldCheck size={14} aria-hidden="true" /> Verification codes expire after 10 minutes.</p>
    </div>
  </main>
}
