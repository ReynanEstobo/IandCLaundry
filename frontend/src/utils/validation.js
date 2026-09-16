export const PHILIPPINE_MOBILE_PATTERN = /^09\d{9}$/
export const PASSWORD_REQUIREMENTS = '12–128 characters with uppercase, lowercase, number, and symbol; no spaces.'

export function normalizePhone(value) {
  return String(value || '').replace(/\D/g, '').slice(0, 11)
}

export function isValidPhilippineMobile(value) {
  return PHILIPPINE_MOBILE_PATTERN.test(String(value || ''))
}

export function passwordPolicyError(password, identifier = '') {
  const value = String(password || '')
  if (value.length < 12 || value.length > 128) return 'Use 12–128 characters.'
  if (/\s/.test(value)) return 'Do not use spaces in your password.'
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/\d/.test(value) || !/[^A-Za-z0-9]/.test(value)) {
    return 'Include an uppercase letter, lowercase letter, number, and symbol.'
  }
  const identifierPart = String(identifier || '').split('@')[0].trim().toLowerCase()
  if (identifierPart.length >= 4 && value.toLowerCase().includes(identifierPart)) return 'Do not include your account name or email in the password.'
  return ''
}
