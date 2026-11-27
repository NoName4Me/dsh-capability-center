import { readFile } from 'node:fs/promises'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EngineSupervisor, normalizeServerUrl } from './lib/supervisor.js'

export const inject = ['webServer', 'connection', 'skills', 'tools', 'pluginManager']

const PREFIX = '/capability-center'
const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
const FILES = new Map([
  ['/', ['page/fallback.html', 'text/html; charset=utf-8']],
  ['/favicon.svg', ['icon.svg', 'image/svg+xml']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
])

function sendMethod(res, allow) {
  res.statusCode = 405
  res.setHeader('allow', allow)
  res.end()
}

async function sendStatic(res, entry, method) {
  const body = await readFile(join(PACKAGE_ROOT, entry[0]))
  res.statusCode = 200
  res.setHeader('content-type', entry[1])
  res.setHeader('cache-control', 'no-cache')
  res.setHeader('content-length', String(body.byteLength))
  res.setHeader('content-security-policy',
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
    + "connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'")
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'no-referrer')
  if (method === 'HEAD') res.end()
  else res.end(body)
}

function sameOriginMutation(req, res) {
  const reject = message => {
    const body = Buffer.from(JSON.stringify({ code: 'same-origin-required', message }))
    res.statusCode = 403
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('content-length', String(body.byteLength))
    res.end(body)
  }
  if (String(req.headers['x-capability-center'] ?? '') !== '1') {
    reject('缺少能力中心同源请求标记。')
    return false
  }
  const fetchSite = req.headers['sec-fetch-site']
  if (fetchSite !== undefined && !['same-origin', 'none'].includes(String(fetchSite))) {
    reject('拒绝跨站请求。')
    return false
  }
  if (req.headers.origin !== undefined) {
    try {
      if (new URL(String(req.headers.origin)).host !== String(req.headers.host ?? '')) throw new Error('origin')
    } catch {
      reject('请求 Origin 与 DSH 服务不一致。')
      return false
    }
  }
  return true
}

export function apply(ctx) {
  const supervisor = new EngineSupervisor(ctx, { packageRoot: PACKAGE_ROOT })
  const reject = (req, res) => {
    const rejection = ctx.connection.requestRejection(req)
    if (rejection === undefined) return false
    res.statusCode = rejection
    res.end()
    return true
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: PREFIX,
    handler: async (req, res) => {
      if (reject(req, res)) return
      const url = new URL(String(req.url), 'http://localhost')
      const route = url.pathname.slice(PREFIX.length) || '/'
      try {
        if (route.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method)) {
          if (!sameOriginMutation(req, res)) return
        }
        if (await supervisor.handle(req, res, route, url)) return
        if (!['GET', 'HEAD'].includes(req.method)) return sendMethod(res, 'GET, HEAD')
        const entry = route === '/' || FILES.has(route) ? FILES.get(route) : undefined
        if (entry === undefined) {
          if (extname(route) !== '') {
            res.statusCode = 404
            res.end()
          } else {
            await sendStatic(res, FILES.get('/'), req.method)
          }
          return
        }
        await sendStatic(res, entry, req.method)
      } catch (error) {
        const status = Number(error?.status)
        const body = Buffer.from(JSON.stringify({
          code: error?.code ?? 'internal-error',
          message: error instanceof Error ? error.message : String(error),
        }))
        res.statusCode = Number.isInteger(status) && status >= 400 && status < 600 ? status : 500
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.setHeader('content-length', String(body.byteLength))
        res.end(body)
      }
    },
  }), `capability-center: ${PREFIX}`)

  ctx.effect(() => () => supervisor.dispose(), 'capability-center: versioned core')
}

export { normalizeServerUrl }
