import { CheckCircle2, Eye, EyeOff, KeyRound, LockKeyhole, MailCheck, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import { apiFetch } from '../services/api/client'
import LoadingButton from '../components/LoadingButton'
import ChangeEmail from '../components/ChangeEmail'
import useOtpCooldown from '../hooks/useOtpCooldown'
import { clearOtpSession, readOtpSession, writeOtpSession } from '../utils/otpSession'
import { passwordPolicyError } from '../utils/validation'

const OTP_SESSION_KEY = 'ic-laundry:account-password-otp'
const OTP_COOLDOWN_KEY = 'ic-laundry:account-password-otp-cooldown'

function PasswordField({ label, value, onChange, visible, onToggle, placeholder, disabled }) {
  return <div className="login-field">
    <label>{label}</label>
    <div className="login-input-wrap">
      <LockKeyhole size={15} className="login-input-icon" />
      <input className="login-input login-input-password" type={visible ? 'text' : 'password'} disabled={disabled} value={value} onChange={event => onChange(event.target.value)} minLength={12} placeholder={placeholder} autoComplete="new-password" required />
      <button type="button" className="login-eye-btn" disabled={disabled} onClick={onToggle} aria-label={visible ? `Hide ${label}` : `Show ${label}`}>
        {visible ? <EyeOff size={15} /> : <Eye size={15} />}
      </button>
    </div>
  </div>
}

export default function AccountSecurity() {
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
  return <div className="account-security-page">
    <section className="card settings-card account-security-card">
      <div className="settings-card-header account-security-header">
        <div className="settings-card-icon blue"><ShieldCheck size={24} /></div>
        <div><span className="account-security-kicker">ACCOUNT SECURITY</span><h3>Change Password</h3><p>Verify your identity with a one-time code sent to your contact email.</p></div>
      </div>
      <div className="account-security-steps" aria-label="Password change steps"><span className="active"><b>1</b> Request code</span><span className={otpStatus === 'valid' ? 'active' : ''}><b>2</b> Verify email</span><span className={otpStatus === 'valid' ? 'active' : ''}><b>3</b> New password</span></div>
      <form onSubmit={submit} className="login-form account-security-form">
        <LoadingButton type="button" className="account-security-code-button" disabled={cooldown.remaining > 0} onClick={requestCode} loading={sendingCode} loadingLabel="Sending verification code…">
          <MailCheck size={16} /> {destination ? cooldown.label : 'Send verification code'}
        </LoadingButton>
        {cooldown.remaining > 0 && <p className="otp-cooldown-notice" role="status">{cooldown.message}</p>}
        {recoveryEmailMissing && <div className="otp-email-missing" role="alert">No recovery email is bound to your account. Use <strong>Change Bound Email</strong> below to add one before requesting an OTP.</div>}
        {destination && <div className="account-security-notice"><MailCheck size={16} /><span>Code sent to <strong>{destination}</strong>. It expires in 10 minutes.</span></div>}
        <div className="login-field" style={{ marginTop: 16 }}>
          <label>Email verification code</label>
          <div className="login-input-wrap">
            <KeyRound size={15} className="login-input-icon" />
            <input className={`login-input account-security-otp otp-verification-input ${otpStatus}`} inputMode="numeric" maxLength={6} value={otp} disabled={!destination || saving || otpStatus === 'valid' || otpStatus === 'checking'} onChange={event => { const code = event.target.value.replace(/\D/g, ''); setOtp(code); setOtpStatus('idle'); setOtpMessage(''); if (code.length === 6) void verifyCode(code) }} placeholder="000000" aria-invalid={otpStatus === 'invalid'} required />
          </div>
          {otpStatus === 'checking' && <p className="otp-verification-checking" role="status">Checking OTP…</p>}
          {otpMessage && <p className="otp-verification-message" role="alert">{otpMessage}</p>}
        </div>
        {otpStatus === 'valid' && <div className="otp-verification-success" role="status">OTP verified. You can now set a new password.</div>}
        <PasswordField label="New password" value={newPassword} onChange={setNewPassword} visible={visible.next} onToggle={flip('next')} placeholder="Strong password" disabled={saving || otpStatus !== 'valid'} />
        <PasswordField label="Confirm new password" value={confirmation} onChange={setConfirmation} visible={visible.confirmation} onToggle={flip('confirmation')} placeholder="Re-enter your new password" disabled={saving || otpStatus !== 'valid'} />
        <LoadingButton type="submit" className="btn btn-primary" disabled={otpStatus !== 'valid'} loading={saving} loadingLabel="Changing password…"><LockKeyhole size={16} /> Change password</LoadingButton>
      </form>
    </section>
    <ChangeEmail onChanged={() => { clearOtpSession(OTP_SESSION_KEY); setOtp(''); setDestination(''); setOtpStatus('idle') }} />
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
