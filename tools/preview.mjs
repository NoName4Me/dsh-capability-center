import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { readZip } from '../apps/dsh-plugin/core/lib/archive.js'

const prefix = '/capability-center'
const host = '127.0.0.1'
const port = Number(process.env.CAPABILITY_CENTER_PREVIEW_PORT ?? 4173)
const readProjectFile = path => readFile(new URL(path, import.meta.url))

async function previewFeedbackEmail() {
  let value = String(process.env.CAPABILITY_CENTER_FEEDBACK_EMAIL ?? '').trim()
  if (value === '') {
    try {
      const env = await readFile(new URL('../.env', import.meta.url), 'utf8')
      for (const line of env.split(/\r?\n/u)) {
        const match = /^\s*CAPABILITY_CENTER_FEEDBACK_EMAIL\s*=\s*(.*)\s*$/u.exec(line)
        if (match === null) continue
        value = match[1].replace(/^(['"])(.*)\1$/u, '$2').trim()
        break
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  return value !== '' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)
    ? value
    : undefined
}

const [manifest, catalog] = await Promise.all([
  readProjectFile('../apps/dsh-plugin/core/manifest.json').then(JSON.parse),
  readProjectFile('../dist/catalog.json').then(JSON.parse),
])
const { version } = manifest
const core = { activeVersion: version, version }
const pages = readZip(await readProjectFile(`../dist/core/capability-center-core-${version}.zip`))
const feedbackEmail = await previewFeedbackEmail()
const json = 'application/json; charset=utf-8'
const routes = new Map([
  [prefix + '/', ['text/html; charset=utf-8', pages.get('page/index.html')]],
  [prefix + '/styles.css', ['text/css; charset=utf-8', pages.get('page/styles.css')]],
  [prefix + '/app.js', ['text/javascript; charset=utf-8', pages.get('page/app.js')]],
  [prefix + '/icon.svg', ['image/svg+xml', pages.get('page/icon.svg')]],
  [prefix + '/api/core/status', [json, JSON.stringify(core)]],
  [prefix + '/api/config', [json, JSON.stringify(
    feedbackEmail === undefined ? {} : { feedbackEmail },
  )]],
  [prefix + '/api/status', [json, JSON.stringify({
    catalog, core, online: true, preview: true, localStates: {},
  })]],
])

createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD', 'content-type': json })
    res.end(JSON.stringify({ message: '请在 DSH 内执行此操作。' }))
    return
  }

  const path = new URL(req.url, `http://${host}`).pathname
  if (path === '/' || path === prefix) {
    res.writeHead(302, { location: prefix + '/' }).end()
    return
  }
  const route = routes.get(path)
  if (!route) {
    res.writeHead(404).end()
    return
  }
  const [contentType, body] = route
  res.writeHead(200, { 'content-type': contentType, 'cache-control': 'no-store' })
  res.end(req.method === 'HEAD' ? undefined : body)
}).listen(port, host, function () {
  console.log(`能力中心本地预览 http://${host}:${this.address().port}${prefix}/`)
})
