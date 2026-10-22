import assert from 'node:assert/strict'
import test from 'node:test'
import worker from '../cloudflare/worker.js'

// The asset binding answers any unknown path with the app page (single-page
// application fallback), the same way Cloudflare does.
const env = {
  RATE_LIMITER: { idFromName: name => name, get: () => ({ fetch: async () => Response.json({ allowed: true }) }) },
  ASSETS: {
    fetch: async request => {
      const { pathname } = new URL(request.url)
      if (pathname === '/assets/index-current.js') return new Response('export {}', { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'public, max-age=0, must-revalidate' } })
      return new Response('<!doctype html><div id="root"></div>', { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=0, must-revalidate' } })
    },
  },
}
const get = path => worker.fetch(new Request(`https://test.iclaundry.local${path}`), env)

test('the app page is never stored, so a duplicated or restored tab loads the current version', async () => {
  for (const path of ['/', '/login', '/orders']) {
    const response = await get(path)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  }
})

test('a built file from an older version is not found instead of returning the app page', async () => {
  const missing = await get('/assets/Login-old1234.js')
  assert.equal(missing.status, 404)
  assert.match(missing.headers.get('content-type'), /text\/plain/)

  const current = await get('/assets/index-current.js')
  assert.equal(current.status, 200)
  assert.equal(current.headers.get('cache-control'), 'public, max-age=0, must-revalidate')
})
