import { ArrowLeft, Eye, EyeOff, LockKeyhole, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import LoadingButton from '../components/LoadingButton'
import { useAuth } from '../context/AuthContext'
import { supabase } from '../lib/supabase'
import { passwordPolicyError } from '../utils/validation'

// How the page addresses the account being activated.
const ACCOUNT_LABELS = { admin: 'administrator', staff: 'staff' }

export default function ActivatePassword() {
  const navigate = useNavigate()
  const { role, signOut } = useAuth()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [saving, setSaving] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const accountLabel = ACCOUNT_LABELS[role]

  // The temporary password is still signed in here, so going back signs it
  // out first; otherwise the sign-in page would send the person straight back.
  async function backToSignIn() {
    if (saving || leaving) return
    setLeaving(true)
    try {
      await signOut()
    } finally {
      navigate('/login', { replace: true })
    }
  }

  async function submit(event) {
    event.preventDefault()
    const policyError = passwordPolicyError(password)
    if (policyError) return toast.error(policyError)
    if (password !== confirmPassword) return toast.error('Passwords do not match.')
    setSaving(true)
    try {
      const { error } = await supabase.auth.updateUser({ password })
      if (error) throw new Error(error.message)
      toast.success('Password created. Your account is now active.')
      navigate('/dashboard', { replace: true })
    } catch (error) {
      toast.error(error.message || 'Unable to activate the account.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <main className="auth-page">
      <div className="auth-shell">
        <button type="button" className="auth-back" onClick={backToSignIn} disabled={saving || leaving}>
          <ArrowLeft size={16} aria-hidden="true" />
          {leaving ? 'Signing out…' : 'Back to sign in'}
        </button>
        <div className="auth-brand">
          <img src="/assets/Rectangle.png" width={1024} height={1024} alt="" />
          <span>I&amp;C Laundry</span>
        </div>
        <section className="auth-card" aria-labelledby="activate-title">
          <header className="auth-card-header">
            <span className="auth-card-icon"><ShieldCheck size={20} aria-hidden="true" /></span>
            <h1 id="activate-title">{accountLabel ? `Activate your ${accountLabel} account` : 'Activate your account'}</h1>
            <p>Create your own private password before using I&amp;C Laundry.</p>
          </header>
          <form onSubmit={submit} className="login-form">
            <div className="login-field">
              <label htmlFor="activate-password">New password</label>
              <div className="login-input-wrap">
                <LockKeyhole size={15} className="login-input-icon" />
                <input id="activate-password" aria-describedby="activate-password-rules" className="login-input login-input-password" type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} minLength={12} autoComplete="new-password" required />
                <button type="button" className="login-eye-btn" onClick={() => setShowPassword(visible => !visible)} aria-label={showPassword ? 'Hide new password' : 'Show new password'}>
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              <p id="activate-password-rules" className="auth-hint">12–128 characters, with an uppercase letter, a lowercase letter, a number, and a symbol. No spaces.</p>
            </div>
            <div className="login-field">
              <label htmlFor="activate-password-confirm">Confirm new password</label>
              <div className="login-input-wrap">
                <LockKeyhole size={15} className="login-input-icon" />
                <input id="activate-password-confirm" className="login-input login-input-password" type={showConfirmation ? 'text' : 'password'} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} minLength={12} autoComplete="new-password" required />
                <button type="button" className="login-eye-btn" onClick={() => setShowConfirmation(visible => !visible)} aria-label={showConfirmation ? 'Hide confirmation password' : 'Show confirmation password'}>
                  {showConfirmation ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
            </div>
            <LoadingButton type="submit" className="login-submit-btn" loading={saving} loadingLabel="Activating…">Activate account</LoadingButton>
          </form>
        </section>
        <p className="auth-footnote">
          <LockKeyhole size={14} aria-hidden="true" /> Use a password you don’t use on any other site.
        </p>
      </div>
    </main>
  )
}
