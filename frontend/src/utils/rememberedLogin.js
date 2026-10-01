const REMEMBERED_LOGIN_KEY = 'ic-laundry-remembered-login'

export function getRememberedLogin() {
  try {
    const value = String(globalThis.localStorage?.getItem(REMEMBERED_LOGIN_KEY) || '').trim()
    return value
  } catch {
    return ''
  }
}

export function setRememberedLogin(identifier) {
  const value = String(identifier || '').trim()
  try {
    if (value) globalThis.localStorage?.setItem(REMEMBERED_LOGIN_KEY, value)
    else globalThis.localStorage?.removeItem(REMEMBERED_LOGIN_KEY)
  } catch {
    // Login must continue even when storage is unavailable or blocked.
  }
}

export async function saveBrowserCredential(identifier, password) {
  const value = String(identifier || '').trim()
  if (!value || !password || typeof globalThis.PasswordCredential !== 'function'
    || !globalThis.navigator?.credentials?.store) return false

  try {
    const credential = new globalThis.PasswordCredential({
      id: value,
      name: value,
      password,
    })
    await globalThis.navigator.credentials.store(credential)
    return true
  } catch {
    // Some browsers use their own password-save prompt instead of the
    // Credential Management API. Standard autocomplete remains available.
    return false
  }
}

export async function getBrowserCredential(expectedIdentifier = '') {
  if (!globalThis.navigator?.credentials?.get) return null

  try {
    const credential = await globalThis.navigator.credentials.get({
      password: true,
      mediation: 'optional',
    })
    if (!credential || !('password' in credential)) return null

    const identifier = String(credential.id || '').trim()
    const expected = String(expectedIdentifier || '').trim().toLowerCase()
    if (!identifier || (expected && identifier.toLowerCase() !== expected)) return null

    return { identifier, password: String(credential.password || '') }
  } catch {
    return null
  }
}

