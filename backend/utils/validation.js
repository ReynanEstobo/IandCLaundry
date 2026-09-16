const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHILIPPINE_MOBILE_PATTERN = /^09\d{9}$/
const PASSWORD_MAX_LENGTH = 128

function badRequest(message) {
  return Object.assign(new Error(message), { status: 400 })
}

export function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '')
}

export function assertPhilippineMobile(value, { required = true, label = 'Phone number' } = {}) {
  const phone = normalizePhone(value)
  if (!phone && !required) return ''
  if (!PHILIPPINE_MOBILE_PATTERN.test(phone)) {
    throw badRequest(`${label} must start with 09 and contain exactly 11 digits.`)
  }
  return phone
}

export function assertEmail(value, { required = false, label = 'Email address' } = {}) {
  const email = String(value || '').trim().toLowerCase()
  if (!email && !required) return ''
  if (email.length > 254 || !EMAIL_PATTERN.test(email)) throw badRequest(`Enter a valid ${label.toLowerCase()}.`)
  return email
}

export function assertText(value, { label = 'This field', min = 1, max = 255, required = true } = {}) {
  const text = String(value || '').trim().replace(/\s+/g, ' ')
  if (!text && !required) return ''
  if (text.length < min || text.length > max) {
    throw badRequest(`${label} must contain ${min}${max === min ? '' : `–${max}`} characters.`)
  }
  return text
}

export function passwordPolicyError(password, identifier = '') {
  const value = String(password || '')
  if (value.length < 12 || value.length > PASSWORD_MAX_LENGTH) return 'Use 12–128 characters.'
  if (/\s/.test(value)) return 'Do not use spaces in your password.'
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value) || !/[^A-Za-z0-9]/.test(value)) {
    return 'Include an uppercase letter, lowercase letter, number, and symbol.'
  }
  const identifierPart = String(identifier || '').split('@')[0].trim().toLowerCase()
  if (identifierPart.length >= 4 && value.toLowerCase().includes(identifierPart)) return 'Do not include your account name or email in the password.'
  return ''
}

export function assertStrongPassword(password, identifier = '') {
  const error = passwordPolicyError(password, identifier)
  if (error) throw badRequest(`Password is not strong enough. ${error}`)
  return String(password)
}

export const PASSWORD_REQUIREMENTS = '12–128 characters with uppercase, lowercase, number, and symbol; no spaces.'
