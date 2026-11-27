import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'
import { root } from './helpers.js'

test('client bridge creates a fresh DSH chat with a prefilled prompt and never sends it', async () => {
  const code = await readFile(join(root, 'apps', 'dsh-plugin', 'bootstrap', 'client.js'), 'utf8')
  assert.doesNotMatch(code, /\.submit\s*\(/u)
  let registration
  const listeners = new Map()
  const documentListeners = new Map()
  const cleanups = []
  const source = {
    posted: [],
    postMessage(message, origin) {
      this.posted.push({ message, origin })
    },
  }
  const created = []
  const retained = []
  const drafts = []
  const opened = []
  const readyValue = { binding: { sessionId: 'new-session' } }
  let readyResolve
  const ready = new Promise(resolveReady => { readyResolve = resolveReady })
  const services = {
    sessions: {
      list: {
        getSnapshot: () => ({
          phase: 'ready',
          byId: {
            old: { updatedAt: 10 },
            recent: { updatedAt: 20 },
          },
        }),
      },
      async create(options) {
        created.push(options)
        return 'new-session'
      },
      retain(sessionId, options) {
        const reference = {
          binding: readyValue.binding,
          ready,
          released: false,
          release() { this.released = true },
          options,
        }
        retained.push(reference)
        return reference
      },
    },
    workspaces: {
      list: {
        getSnapshot: () => ({
          phase: 'ready',
          items: [
            { workspaceId: 'older-workspace', sessionIds: ['old'], createdAt: '2026-01-01T00:00:00Z' },
            { workspaceId: 'current-workspace', sessionIds: ['recent'], createdAt: '2026-01-02T00:00:00Z' },
          ],
        }),
      },
    },
    conversation: {
      input: {
        requestDraftInitialization(binding, options) {
          drafts.push({ binding, options })
          return 'applied'
        },
      },
    },
    uiWorkspace: {
      openSession(sessionId) {
        opened.push(sessionId)
      },
    },
  }
  const browserWindow = {
    location: { origin: 'https://dsh.local', reload() { this.reloads = (this.reloads ?? 0) + 1 } },
    localStorage: {
      getItem() { return null },
    },
    sessionStorage: new Map(),
    addEventListener(type, listener) {
      listeners.set(type, listener)
    },
    removeEventListener(type) {
      listeners.delete(type)
    },
  }
  browserWindow.sessionStorage = {
    getItem(key) { return this.values?.get(key) ?? null },
    setItem(key, value) { this.values ??= new Map(); this.values.set(key, String(value)) },
    removeItem(key) { this.values?.delete(key) },
  }
  const requests = []
  const sandbox = {
    AbortController,
    clearTimeout,
    setTimeout,
    setInterval,
    clearInterval,
    document: {
      visibilityState: 'visible',
      addEventListener(type, listener) { documentListeners.set(type, listener) },
      removeEventListener(type) { documentListeners.delete(type) },
    },
    window: {
      __ModuleLoader__: {
        load(value) {
          registration = value
        },
      },
      ...browserWindow,
      fetch: async url => {
        requests.push(String(url))
        return {
          ok: true,
          async json() { return { attention: true } },
        }
      },
    },
  }
  vm.runInNewContext(code, sandbox)
  assert.equal(registration.id, 'capability-center')
  assert.equal(typeof registration.factory, 'function')
  const react = {
    createElement(tag, props, ...children) {
      return { tag, props, children }
    },
    useEffect() {},
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot()
    },
  }
  const loaded = registration.factory(name => {
    if (name === 'react') return react
    throw new Error(`unexpected dependency ${name}`)
  })
  assert.deepEqual(
    Array.from(loaded.inject),
    ['slots', 'sessions', 'workspaces', 'conversation', 'uiWorkspace'],
  )
  const registered = []
  const ctx = {
    get(name) {
      return services[name]
    },
    effect(callback) {
      const cleanup = callback()
      cleanups.push(cleanup)
      return cleanup
    },
    slots: {
      inject(_name, callback) {
        const value = callback()
        if (value && typeof value[Symbol.iterator] === 'function') Array.from(value)
      },
      register(options, component) {
        registered.push({ options, component })
        return () => undefined
      },
    },
  }
  loaded.apply(ctx)
  const main = registered.find(value => value.options.name === 'main')
  const sidebar = registered.find(value => value.options.name === 'sidebar.panellist')
  const overlay = registered.find(value => value.options.name === 'shell.overlay')
  assert.equal(main.options.key, 'capability-center')
  assert.equal(sidebar.options.id, 'capability-center')
  assert.equal(overlay.options.id, 'capability-center.refresh-toast')
  const rendered = main.component()
  assert.equal(rendered.children[0].props.src, '/capability-center/')
  rendered.children[0].props.ref({ contentWindow: source })

  const prompt = '这是真实换行提示词\n第二行只进入草稿。'
  const message = {
    type: 'capability-center/open-draft',
    requestId: 'request_12345678',
    itemId: 'office-enhancement',
    prompt,
    origin: 'https://dsh.local',
  }
  await listeners.get('message')({
    origin: 'https://dsh.local',
    source,
    data: message,
  })
  readyResolve(readyValue.binding)
  await new Promise(resolveWait => setImmediate(resolveWait))
  assert.deepEqual(created.map(value => ({ ...value })), [{ workspaceId: 'current-workspace' }])
  assert.equal(retained[0].options.source, 'workspaceOperation')
  assert.equal(drafts.length, 1)
  assert.equal(drafts[0].options.prompt, prompt)
  assert.equal(drafts[0].options.clearPreviousDraft, false)
  assert.deepEqual(opened, ['new-session'])
  assert.equal(retained[0].released, true)
  assert.equal(source.posted.at(-1).message.ok, true)

  await new Promise(resolveWait => setTimeout(resolveWait, 30))
  const icon = sidebar.component({ size: 16, active: false })
  assert.equal(icon.children[0].props.style.width, 16)
  assert.match(icon.children[0].props.style.mask, /\/capability-center\/icon\.svg/u)
  assert.equal(icon.children.length, 2)
  assert.ok(requests.some(url => url.includes('/api/updates')))

  const wrong = await listeners.get('message')({
    origin: 'https://dsh.local',
    source,
    data: { ...message, extra: 'not allowed', requestId: 'request_wrong_keys' },
  })
  assert.equal(wrong, undefined)
  await Promise.resolve()
  assert.equal(created.length, 1)
  assert.equal(drafts.length, 1)

  const reloadsBefore = browserWindow.location.reloads ?? 0
  await listeners.get('message')({
    origin: 'https://dsh.local',
    source,
    data: {
      type: 'capability-center/reload-dsh',
      target: 'plugin',
      itemId: 'auto-continue',
      version: '1.1.0',
      action: 'update',
      origin: 'https://dsh.local',
      extra: 'not allowed',
    },
  })
  await new Promise(resolveWait => setTimeout(resolveWait, 60))
  assert.equal(browserWindow.location.reloads ?? 0, reloadsBefore)

  await listeners.get('message')({
    origin: 'https://dsh.local',
    source,
    data: {
      type: 'capability-center/reload-dsh',
      target: 'plugin',
      itemId: 'auto-continue',
      version: '1.1.0',
      action: 'install',
      origin: 'https://dsh.local',
    },
  })
  await new Promise(resolveWait => setTimeout(resolveWait, 60))
  assert.equal(browserWindow.location.reloads, 1)
  assert.equal(
    JSON.parse(browserWindow.sessionStorage.getItem('capability-center.refresh-pending')).action,
    'install',
  )

  for (const cleanup of cleanups.reverse()) await cleanup?.()
})

test('UI source exposes category filters, card details, update results and offline management', async () => {
  const [html, app, css, client] = await Promise.all([
    readFile(join(root, 'apps', 'dsh-plugin', 'core', 'page', 'index.html'), 'utf8'),
    readFile(join(root, 'apps', 'dsh-plugin', 'core', 'page', 'app.ts'), 'utf8'),
    readFile(join(root, 'apps', 'dsh-plugin', 'core', 'page', 'styles.css'), 'utf8'),
    readFile(join(root, 'apps', 'dsh-plugin', 'bootstrap', 'client.js'), 'utf8'),
  ])
  for (const label of ['全部', '技能', '插件', 'MCP', '能力包', '已安装']) {
    assert.match(html, new RegExp(`>${label}<`, 'u'))
  }
  assert.doesNotMatch(html, />Python 库</u)
  assert.match(app, /检查与修复/u)
  assert.match(app, /卸载/u)
  assert.match(html, /关闭详情/u)
  assert.match(app, /核心 v\$\{pending\.version\} 已暂存/u)
  assert.match(app, /刷新生效/u)
  assert.match(app, /\/api\/core\/activate/u)
  assert.match(app, /state\.refreshBridge\.coreActivation/u)
  assert.match(app, /state\.refreshBridge\.reload/u)
  assert.match(app, /已生效，请手动刷新页面/u)
  assert.match(app, /\/api\/refresh-state/u)
  assert.match(app, /\/api\/config/u)
  assert.match(app, /category !== 'mcp'/u)
  assert.match(app, /已是最新版本/u)
  assert.match(app, /分发服务器没有兼容版本/u)
  assert.match(html, /<dialog[^>]+aria-labelledby="capability-dialog-title"/u)
  assert.match(html, /<form method="dialog">/u)
  assert.match(html, /href="\/capability-center\/styles\.css"/u)
  assert.match(html, /src="\/capability-center\/app\.js"/u)
  assert.match(app, /detailDialog\.showModal\(\)/u)
  assert.match(app, /renderActions\(item, status, 'card'\)/u)
  assert.match(app, /capability-card-body/u)
  assert.match(app, /trialAvailable !== false/u)
  assert.match(app, /label: '已安装'/u)
  assert.match(app, /if \(!installed \|\| status\.label === '可更新'\) \{\s*label\.textContent = status\.label;\s*return label;/u)
  assert.match(app, /state\.localOnly \? '' : state\.serverUrl/u)
  assert.match(app, /devDistributionUrl\(\) \|\| localStorage\.getItem\(STORAGE_KEY\)/u)
  assert.match(app, /capability-center-dev-distribution-url/u)
  assert.match(css, /\.capability-list\s*\{[^}]*grid-template-columns: repeat\(auto-fill/u)
  assert.match(app, /草稿尚未发送/u)
  assert.match(app, /legacyManagerEnabled/u)
  assert.match(app, /local\.preexisting/u)
  assert.match(app, /此项需到“DSH 插件页”管理/u)
  assert.match(app, /if \(item\.hidden === true\) return false/u)
  assert.match(app, /document\.documentElement\.dataset\.theme = scheme/u)
  assert.match(app, /data-ds-dark-theme/u)
  assert.match(app, /getComputedStyle\(tokenSource\)/u)
  assert.match(app, /data-ds-theme-source/u)
  assert.match(app, /if \(window\.parent !== window\) \{\s*try \{\s*const observer = new MutationObserver/u)
  assert.doesNotMatch(html, /安装与检查在本机完成/u)
  assert.doesNotMatch(html, /隐私/u)
  assert.doesNotMatch(app, /['"](验证|自检)['"]\s*,?\s*type:\s*['"]button/u)
  assert.match(html, /feedback-dialog/u)
  assert.match(html, /反馈问题或需求/u)
  assert.match(html, /并附能说明问题的截图/u)
  assert.doesNotMatch(html, /<textarea/u)
  assert.doesNotMatch(html, /type="file"/u)
  assert.doesNotMatch(html, /feedback-cancel/u)
  assert.match(app, /\.join\('\\r\\n'\)/u)
  assert.match(app, /mailto:/u)
  assert.doesNotMatch(app, /window\.open/u)
  assert.doesNotMatch(app, /_blank|_top/u)
  assert.match(client, /shell\.overlay/u)
  assert.match(client, /RELOAD_MESSAGE_KEYS/u)
  assert.match(client, /value\.action === 'activate'/u)
  assert.match(client, /已安装并生效/u)
  assert.match(client, /已更新并生效/u)
  assert.match(client, /UPDATE_CHECK_INTERVAL_MS/u)
  assert.match(app, /PLUGIN_REFRESH_KEY/u)
  assert.match(app, /hostReloadedSince/u)
  assert.match(app, /state\.refreshBridge\.reload\s*\n?\s*&& operation\.status/u)
  assert.match(app, /JSON\.stringify\(\{ version: pending\.version \}\)/u)
  assert.match(client, /refresh-state\?itemId=/u)
  assert.match(client, /background:\s*'#d92d20'/u)
  assert.match(css, /--blue:\s*#4059dc/u)
  assert.match(css, /--page:\s*#fff/u)
  assert.match(css, /:root\[data-theme="dark"\][\s\S]*?--page:\s*#151517/u)
  assert.match(css, /html, body \{ height: 100%; \}/u)
  assert.match(css, /grid-template-rows: minmax\(0, 1fr\) auto/u)
  assert.match(css, /\.center-shell\s*\{[\s\S]*?overflow: auto;/u)
  assert.doesNotMatch(css, /\.capability-item:hover/u)
  assert.match(css, /\.filters\s*\{[^}]*flex-wrap:\s*wrap/u)
  assert.doesNotMatch(css, /\.filters\s*\{[^}]*overflow-x/u)
  assert.match(css, /prefers-reduced-motion/u)
})

