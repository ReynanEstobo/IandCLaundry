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
    <div className="login-page-wrapper">
      <div className="login-left-panel">
        <div className="login-left-circle login-left-circle-1" />
        <div className="login-left-circle login-left-circle-2" />
        <div className="login-left-circle login-left-circle-3" />
        <img src="/assets/Rectangle.png" alt="I&C Laundry" className="login-left-logo" />
        <div className="login-left-text">
          <h1>I&C Laundry</h1>
          <p>Professional laundry services - fresh, clean, and perfectly cared every time.</p>
        </div>
      </div>

      <div className="login-right-panel">
        <div className="login-grid-bg" />
        <div className="login-form-wrapper">
          <button onClick={() => navigate('/')} className="login-back-btn" disabled={loading}>
            <ArrowLeft size={15} /> Back to Home
          </button>
          <div className="login-card-enhanced">
            <div className="login-card-header">
              <div className="login-card-icon"><img src="/assets/Rectangle.png" alt="I&C Laundry" /></div>
              <div><h2>Welcome back</h2><p>Sign in to I&C Laundry dashboard</p></div>
            </div>
            {error && <div className="login-error-enhanced"><AlertCircle size={15} />{error}</div>}
            <form onSubmit={handleSubmit} className="login-form" autoComplete="on">
              <div className="login-field">
                <label>Account ID or Username</label>
                <div className="login-input-wrap">
                  <UserRound size={15} className="login-input-icon" />
                  <input
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
                <label>Password</label>
                <div className="login-input-wrap">
                  <Lock size={15} className="login-input-icon" />
                  <input
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
              <p className="login-remember-hint">
                Your account is remembered by this system; your password is protected by your browser's password manager.
              </p>
              <LoadingButton type="submit" className="login-submit-btn" loading={loading} loadingLabel="Signing in...">Sign In</LoadingButton>
              <div className="login-card-footer" style={{ marginTop: 16 }}>
                <button type="button" className="login-forgot-password" disabled={loading} onClick={() => navigate('/forgot-password')}>Forgot password?</button>
              </div>
            </form>
            <div className="login-card-footer">Powered by I&C Laundry &copy; {new Date().getFullYear()}</div>
          </div>
        </div>
      </div>
    </div>
  )
}
