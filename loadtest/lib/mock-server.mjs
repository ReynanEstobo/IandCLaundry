// A stand-in for the backend used by `node loadtest/run.mjs --mock` to check
// the load-test tool itself: same routes, small random delays, fake data.
import http from 'node:http'
import { randomUUID } from 'node:crypto'

const wait = () => new Promise(resolve => setTimeout(resolve, 5 + Math.random() * 25))

export function startMockServer() {
  const addresses = new Set()
  let sequence = 0
  const server = http.createServer(async (request, response) => {
    addresses.add(request.socket.remoteAddress)
    let body = ''
    for await (const chunk of request) body += chunk
    await wait()
    const url = new URL(request.url, 'http://mock')
    const send = (status, data, headers = {}) => {
      response.writeHead(status, { 'Content-Type': 'application/json', ...headers })
      response.end(JSON.stringify(data))
    }
    if (url.pathname === '/api/auth/login') {
      return send(200, { session: { user: {} } }, { 'Set-Cookie': `ic_access=mock-${randomUUID()}; Path=/; HttpOnly` })
    }
    if (!url.pathname.startsWith('/api/public/') && !request.headers.authorization) return send(401, { error: 'Authentication required' })
    if (url.pathname === '/api/service-types') return send(200, { data: [{ id: 'service-1', name: 'Wash & Fold Demo', is_active: true }] })
    if (url.pathname === '/api/orders/create') {
      sequence += 1
      return send(200, { data: { id: randomUUID(), order_number: `IC-MOCK-${String(sequence).padStart(6, '0')}` } })
    }
    if (url.pathname === '/api/public/orders/track') return send(200, { data: [] })
    if (url.pathname === '/api/orders/page') return send(200, { data: [], count: 0 })
    return send(200, { data: [], count: 0 })
  })
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({
    port: server.address().port,
    addresses,
    close: () => new Promise(done => { server.closeAllConnections?.(); server.close(done) }),
  })))
}
