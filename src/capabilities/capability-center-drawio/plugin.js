import { randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, extname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DrawioCanvasService } from './index.js'

export const inject = ['tools', 'agents']

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
const PREFIX = '/capability-center-drawio'
const DRAWIO_ROOT = join(PACKAGE_ROOT, 'drawio')
const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.drawio', 'application/vnd.jgraph.mxfile'],
  ['.eot', 'application/vnd.ms-fontobject'],
  ['.gif', 'image/gif'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.map', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.ttf', 'font/ttf'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.wasm', 'application/wasm'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.xml', 'application/xml; charset=utf-8'],
])

function visualGuidanceText() {
  return [
    'Current same-origin draw.io visual contract:',
    '- Follow the user\'s explicit style, colors, brand, and reference examples first.',
    '- Otherwise preserve the board\'s existing visual language and choose a cohesive theme from the subject and audience.',
    '- Avoid draw.io defaults (#dae8fc, #d5e8d4, #e1d5e7, #fff2cc, #f8cecc). Use restrained fills, thin borders, strong text contrast, generous spacing, and a small accent palette.',
    '- Prefer role-based nodes over ad-hoc styles. Only add explicit colors when the user requests them.',
  ].join('\n')
}

export function createDrawioSelectionContext(selection) {
  const selected = Array.isArray(selection?.selection?.cellIds)
    ? selection.selection.cellIds
    : []
  if (!selected.length) return undefined
  const visibleIds = selected.slice(0, 64)
  const payload = JSON.stringify({
    boardId: selection.boardId,
    revision: selection.revision,
    pageId: selection.pageId,
    selectedCellIds: visibleIds,
    omittedSelectedCellCount: Math.max(0, selected.length - visibleIds.length),
  })
  const text = 'Current same-origin draw.io selection context:\n'
    + `${payload}\nselectedCellIds=${visibleIds.join(',')}\n`
    + 'Call drawio_get_selection with this boardId to verify the board and revision before drawio_edit. '
    + 'Use the IDs captured for this message. A later selection must not replace them.\n\n'
    + visualGuidanceText()
  const sections = Object.freeze([{ name: 'drawio-selection', text }])
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({
      kind: 'capability-center-drawio',
      form: 'snapshot',
      selectedCellCount: selected.length,
      sections,
    }),
  })
}

export function createDrawioDesignContext(selection) {
  if (typeof selection?.boardId !== 'string' || typeof selection?.pageId !== 'string') return undefined
  const payload = JSON.stringify({
    boardId: selection.boardId,
    revision: selection.revision,
    pageId: selection.pageId,
  })
  const text = `Current same-origin draw.io board context:\n${payload}\n\n${visualGuidanceText()}`
  const sections = Object.freeze([{ name: 'drawio-design', text }])
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([{ type: 'text', text }]),
    source: Object.freeze({
      kind: 'capability-center-drawio',
      form: 'guideline',
      sections,
    }),
  })
}

function dshHome() {
  const configured = String(process.env.DSH_HOME ?? '').trim()
  return configured === '' ? join(homedir(), '.dsh') : configured
}

function sameOriginMutation(req, res) {
  const reject = message => {
    const body = Buffer.from(JSON.stringify({ code: 'same-origin-required', message }))
    res.writeHead(403, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.byteLength),
    }).end(body)
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
      if (new URL(String(req.headers.origin)).host !== String(req.headers.host ?? '')) {
        throw new Error('origin')
      }
    } catch {
      reject('请求 Origin 与 DSH 服务不一致。')
      return false
    }
  }
  return true
}

async function sendAsset(req, res, route) {
  let decoded
  try {
    decoded = decodeURIComponent(route)
  } catch {
    res.writeHead(400).end()
    return
  }
  if (decoded === '' || decoded.startsWith('/') || decoded.includes('\0')
    || decoded.includes('\\') || decoded.split('/').some(part => part === '..' || part === '')) {
    res.writeHead(404).end()
    return
  }
  const target = resolve(DRAWIO_ROOT, ...decoded.split('/'))
  const root = resolve(DRAWIO_ROOT)
  if (!target.startsWith(`${root}${sep}`)) {
    res.writeHead(404).end()
    return
  }
  let info
  try {
    info = await stat(target)
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      res.writeHead(404).end()
      return
    }
    throw error
  }
  if (!info.isFile()) {
    res.writeHead(404).end()
    return
  }
  const type = CONTENT_TYPES.get(extname(target).toLowerCase()) ?? 'application/octet-stream'
  res.writeHead(200, {
    'content-type': type,
    'content-length': String(info.size),
    'cache-control': extname(target).toLowerCase() === '.html' ? 'no-cache' : 'public, max-age=86400',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
      + "img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; "
      + "worker-src 'self' blob:; frame-src 'self'; frame-ancestors 'self'; "
      + "base-uri 'none'; form-action 'none'; object-src 'none'",
    'cross-origin-resource-policy': 'same-origin',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  })
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  await new Promise((resolveStream, rejectStream) => {
    const stream = createReadStream(target)
    stream.on('error', rejectStream)
    res.on('finish', resolveStream)
    res.on('close', resolveStream)
    stream.pipe(res)
  })
}

function explicitlyRequestsDrawing(text) {
  if (/(?:不要|不用|无需|不必|别|禁止)[^，。！？\n]{0,14}(?:画|绘制|制图|draw\.io)|\b(?:do not|don't|no need to)\s+(?:draw|diagram|sketch)\b/iu.test(text)) {
    return false
  }
  return text.split(/[。！？；\n]/u).some(clause =>
    /(?:^|[，,：:]|(?:请|能否|能不能|可以|帮我|给我|为我|想请你|麻烦你)\s*)(?:用\s*draw\.io\s*)?(?:画出?|绘制|生成|制作|创建|做|绘画)[^，,]{0,60}(?:图|画板|画布|diagram)/iu.test(clause.trim())
    || /(?:^|[，,：:]|帮我|给我|请)\s*(?:画一下|画一张|画一个|画个)/u.test(clause.trim())
    || /(?:^|[，,：:]|帮我|给我|请)\s*(?:把|将)[^，,]{1,80}(?:画成|绘制成|做成|转成)[^，,]{0,24}(?:图|画板|画布)/u.test(clause.trim())
    || /^(?:(?:please|(?:can|could|would) you)\s+)*(?:draw|sketch|create|make|generate)\s+(?:me\s+)?(?:an?\s+)?(?:[\w-]+\s+){0,6}(?:diagram|flowchart|canvas)\b/iu.test(clause.trim()))
}

export function apply(ctx) {
  const drawingRequests = new WeakMap()
  const service = new DrawioCanvasService({
    dataRoot: join(dshHome(), 'capability-center-drawio'),
  })
  const toolDisposers = service.registerTools(ctx.tools, agent => drawingRequests.get(agent) === true)
  const ready = service.initialize()
  ready.catch(error => ctx.logger?.warn?.(`capability-center-drawio: ${error?.message ?? error}`))

  ctx.on('agent/pre-step', async ({ agent, messages, step, signal }, next) => {
    const decision = await next()
    if (!agent) return decision
    if (decision.kind === 'reject' || signal.aborted) {
      drawingRequests.delete(agent)
      return decision
    }
    const human = Array.isArray(messages)
      ? messages.findLast(message => message?.role === 'user' && message.source?.kind === 'user')
      : undefined
    if (human !== undefined || step === 1) {
      const text = (Array.isArray(human?.content) ? human.content : [])
        .filter(part => part?.type === 'text' && typeof part.text === 'string')
        .map(part => part.text).join('\n')
      drawingRequests.set(agent, explicitlyRequestsDrawing(text))
    }
    if (step !== 1) return decision
    const sessionId = agent?.id
    if (typeof sessionId !== 'string' || sessionId === '') return decision
    let selection
    try {
      selection = await service.getSelection(sessionId)
    } catch (error) {
      if (['no-board', 'board-session-mismatch', 'unknown-board'].includes(error?.code)) return decision
      throw error
    }
    const context = createDrawioSelectionContext(selection) ?? createDrawioDesignContext(selection)
    if (context === undefined) return decision
    return {
      ...decision,
      messages: [...decision.messages, context],
    }
  }, { prepend: true, global: true })

  ctx.inject(['webServer', 'connection'], routeCtx => {
    routeCtx.effect(() => routeCtx.webServer.register({
      kind: 'prefix',
      path: PREFIX,
      handler: async (req, res) => {
        const rejection = routeCtx.connection.requestRejection(req)
        if (rejection !== undefined) {
          res.writeHead(rejection).end()
          return
        }
        const url = new URL(String(req.url), 'http://localhost')
        const route = url.pathname.slice(PREFIX.length) || '/'
        try {
          if (route.startsWith('/api/') && !['GET', 'HEAD'].includes(req.method)) {
            if (!sameOriginMutation(req, res)) return
          }
          if (await service.handle(req, res, route, url)) return
          if (route.startsWith('/drawio/')) {
            if (!['GET', 'HEAD'].includes(req.method)) {
              res.writeHead(405, { allow: 'GET, HEAD' }).end()
              return
            }
            await ready
            await sendAsset(req, res, route.slice('/drawio/'.length))
            return
          }
          res.writeHead(404).end()
        } catch (error) {
          if (res.headersSent) {
            res.destroy(error)
            return
          }
          const status = Number(error?.status)
          const body = Buffer.from(JSON.stringify({
            code: error?.code ?? 'internal-error',
            message: error instanceof Error ? error.message : String(error),
          }))
          res.writeHead(Number.isInteger(status) && status >= 400 && status < 600 ? status : 500, {
            'content-type': 'application/json; charset=utf-8',
            'content-length': String(body.byteLength),
          }).end(body)
        }
      },
    }), 'capability-center-drawio: HTTP and static editor')
  })

  ctx.effect(() => () => {
    for (const dispose of toolDisposers.reverse()) dispose()
    void ready.catch(() => undefined)
  }, 'capability-center-drawio: tools')
}
