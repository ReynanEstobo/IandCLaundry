import { AlertCircle, ArrowLeft, Eye, EyeOff, Lock, UserRound } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import LoadingButton from '../components/LoadingButton'
import { useAuth } from '../context/AuthContext'
import { getBrowserCredential, getRememberedLogin, saveBrowserCredential, setRememberedLogin } from '../utils/rememberedLogin'

export default function Login() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const rememberedIdentifier = getRememberedLogin()
  const [identifier, setIdentifier] = useState(rememberedIdentifier)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [showPassword, setShowPassword] = useState(false)
  const [rememberMe, setRememberMe] = useState(Boolean(rememberedIdentifier))
  const userEditedLogin = useRef(false)

  useEffect(() => {
    if (!rememberedIdentifier) return undefined

    let active = true
    getBrowserCredential(rememberedIdentifier).then((credential) => {
      if (!active || userEditedLogin.current || !credential) return
      setIdentifier(credential.identifier)
      setPassword(credential.password)
    })

    return () => { active = false }
  }, [rememberedIdentifier])

  async function handleSubmit(event) {
    event.preventDefault()
    if (loading) return
    setError('')
    setLoading(true)
    try {
      const cleanIdentifier = identifier.trim()
      const { error: signInError } = await signIn(cleanIdentifier, password, rememberMe)
      if (signInError) {
        setError(signInError.message)
      } else if (rememberMe) {
        setRememberedLogin(cleanIdentifier)
        void saveBrowserCredential(cleanIdentifier, password)
      } else {
        setRememberedLogin('')
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="login-page-wrapper login-screen">
      <div className="login-shell">
        <section className="login-form-side">
          <div className="login-form-top">
            <div className="login-brand">
              <img src="/assets/Rectangle.png" width={1024} height={1024} alt="" className="login-brand-logo" />
              <span>I&C Laundry</span>
            </div>
            <button type="button" onClick={() => navigate('/')} className="login-back-btn" disabled={loading}>
              <ArrowLeft size={15} /> Back to Home
            </button>
          </div>

          <div className="login-form-wrapper">
            <div className="login-card-header">
              <h1>Welcome back</h1>
              <p>Sign in to I&C Laundry dashboard</p>
            </div>
            {error && <div className="login-error-enhanced" role="alert"><AlertCircle size={15} />{error}</div>}
            <form onSubmit={handleSubmit} className="login-form" autoComplete="on">
              <div className="login-field">
                <label htmlFor="login-username">Account ID or Username</label>
                <div className="login-input-wrap">
                  <UserRound size={15} className="login-input-icon" />
                  <input id="login-username" spellCheck={false}
                    className="login-input"
                    type="text"
                    name="username"
                    autoComplete="username"
                    placeholder="e.g. maria.santos"
                    value={identifier}
                    disabled={loading}
                    onChange={(event) => {
                      userEditedLogin.current = true
                      setIdentifier(event.target.value)
                    }}
                    required
                  />
                </div>
              </div>
              <div className="login-field">
                <label htmlFor="login-password">Password</label>
                <div className="login-input-wrap">
                  <Lock size={15} className="login-input-icon" />
                  <input id="login-password"
                    className="login-input login-input-password"
                    type={showPassword ? 'text' : 'password'}
                    name="password"
                    autoComplete="current-password"
                    placeholder="Enter your password"
                    value={password}
                    disabled={loading}
                    onChange={(event) => {
                      userEditedLogin.current = true
                      setPassword(event.target.value)
                    }}
                    required
                  />
                  <button type="button" className="login-eye-btn" aria-label={showPassword ? 'Hide password' : 'Show password'} disabled={loading} onClick={() => setShowPassword(visible => !visible)}>
                    {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                  </button>
                </div>
              </div>
              <div className="login-options">
                <label className="login-remember-me">
                  <input
                    type="checkbox"
                    checked={rememberMe}
                    disabled={loading}
                    onChange={(event) => {
                      const checked = event.target.checked
                      setRememberMe(checked)
                      if (!checked) setRememberedLogin('')
                    }}
                  />
                  <span>Remember me on this device</span>
                </label>
                <button type="button" className="login-forgot-password" disabled={loading} onClick={() => navigate('/forgot-password')}>Forgot password?</button>
              </div>
              <p className="login-remember-hint">
                Your account is remembered by this system; your password is protected by your browser's password manager.
              </p>
              <LoadingButton type="submit" className="login-submit-btn" loading={loading} loadingLabel="Signing in…">Sign In</LoadingButton>
            </form>
          </div>

          <p className="login-card-footer">Powered by I&C Laundry &copy; {new Date().getFullYear()}</p>
        </section>

        <aside className="login-brand-panel">
          <svg className="login-brand-curve" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 0H84C52 14 30 28 36 48C42 68 74 78 58 100H0Z" />
          </svg>
          <svg className="login-brand-wave" viewBox="0 0 100 20" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 20V9C22 21 42 1 64 7C80 11 90 13 100 6V20Z" />
          </svg>
          <span className="login-brand-streaks" aria-hidden="true"><i /><i /><i /></span>
          <span className="login-brand-bubbles" aria-hidden="true"><i /><i /><i /><i /><i /></span>
          <div className="login-brand-copy">
            <p className="login-brand-name">I&C Laundry</p>
            <p className="login-brand-tagline">Orders, customers, and inventory for every I&C Laundry branch.</p>
          </div>
          <img src="/assets/login-mascot.webp" width={640} height={563} alt="" className="login-brand-mascot" />
        </aside>
      </div>
    </div>
  )
}
