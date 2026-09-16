import { Eye, EyeOff, LockKeyhole, ShieldCheck } from 'lucide-react'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import toast from 'react-hot-toast'
import LoadingButton from '../components/LoadingButton'
import { supabase } from '../lib/supabase'
import { passwordPolicyError } from '../utils/validation'

export default function ActivatePassword() {
  const navigate = useNavigate()
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [showConfirmation, setShowConfirmation] = useState(false)
  const [saving, setSaving] = useState(false)

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
    <main className="login-page-wrapper">
      <section className="login-right-panel" style={{ width: '100%', minHeight: '100vh' }}>
        <div className="login-form-wrapper">
          <div className="login-card-enhanced">
            <div className="login-card-header">
              <div className="login-card-icon"><ShieldCheck size={24} /></div>
              <div>
                <h2>Activate your staff account</h2>
                <p>Create a private password before accessing I&C Laundry.</p>
              </div>
            </div>
            <form onSubmit={submit} className="login-form">
              <div className="login-field">
                <label>New password</label>
                <div className="login-input-wrap">
                  <LockKeyhole size={15} className="login-input-icon" />
                  <input className="login-input login-input-password" type={showPassword ? 'text' : 'password'} value={password} onChange={event => setPassword(event.target.value)} minLength={12} autoComplete="new-password" required />
                  <button type="button" className="login-eye-btn" onClick={() => setShowPassword(visible => !visible)} aria-label={showPassword ? 'Hide new password' : 'Show new password'}>
                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <div className="login-field">
                <label>Confirm new password</label>
                <div className="login-input-wrap">
                  <LockKeyhole size={15} className="login-input-icon" />
                  <input className="login-input login-input-password" type={showConfirmation ? 'text' : 'password'} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} minLength={12} autoComplete="new-password" required />
                  <button type="button" className="login-eye-btn" onClick={() => setShowConfirmation(visible => !visible)} aria-label={showConfirmation ? 'Hide confirmation password' : 'Show confirmation password'}>
                    {showConfirmation ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <LoadingButton type="submit" className="login-submit-btn" loading={saving} loadingLabel="Activating…">Activate account</LoadingButton>
            </form>
          </div>
        </div>
      </section>
    </main>
  )
}
