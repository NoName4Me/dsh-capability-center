import { randomUUID } from 'node:crypto'
import {
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { readZip, safeRelativePath } from './archive.js'
import {
  atomicWriteJson,
  pathBytes,
  readJson,
  removeQuietly,
  sha256,
} from './fs-safe.js'
import { readBoundedUrl } from './http-transport.js'
import { compareVersions, parseVersion, satisfies } from './semver.js'

export const CORE_PROTOCOL_VERSION = 1
export const CORE_PACKAGE_NAME = 'capability-center-core'
export const TARGET_DSH_VERSION = '0.2.1-rc.2'
const INDEX_MAX_BYTES = 1024 * 1024
const CORE_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024

function dshHome() {
  const configured = String(process.env.DSH_HOME ?? '').trim()
  return configured === '' ? join(homedir(), '.dsh') : configured
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

export function normalizeServerUrl(raw) {
  const value = String(raw ?? '').trim()
  let url
  try {
    url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid')
    }
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`
  } catch {
    throw Object.assign(new Error('服务器地址必须是完整且不含账号、查询参数或锚点的 http(s) URL。'), {
      code: 'invalid-server',
    })
  }
  return url.href
}

export function validateCoreManifest(manifest) {
  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) return false
  if (manifest.schemaVersion !== 1
    || manifest.name !== CORE_PACKAGE_NAME
    || parseVersion(manifest.version) === null
    || manifest.protocolVersion !== CORE_PROTOCOL_VERSION
    || typeof manifest.entry !== 'string'
    || !safeRelativePath(manifest.entry)
    || typeof manifest.compatibility !== 'object'
    || manifest.compatibility === null
    || typeof manifest.compatibility.dsh !== 'string'
    || !satisfies(TARGET_DSH_VERSION, manifest.compatibility.dsh)
    || !Array.isArray(manifest.compatibility.os)
    || !Array.isArray(manifest.compatibility.arch)
    || !manifest.compatibility.os.includes(process.platform)
    || !manifest.compatibility.arch.includes(process.arch)) {
    return false
  }
  return true
}

function validateReleaseIndex(index) {
  if (typeof index !== 'object' || index === null || Array.isArray(index)
    || index.schemaVersion !== 1
    || index.protocolVersion !== CORE_PROTOCOL_VERSION
    || !Array.isArray(index.releases)) {
    throw Object.assign(new Error('核心版本索引格式无效。'), { code: 'invalid-core-index' })
  }
  const releases = index.releases.map(release => {
    if (typeof release !== 'object' || release === null || Array.isArray(release)
      || parseVersion(release.version) === null
      || typeof release.archive !== 'string'
      || !safeRelativePath(release.archive)
      || typeof release.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(release.sha256)
      || !Number.isSafeInteger(release.bytes)
      || release.bytes <= 0
      || release.bytes > CORE_ARCHIVE_MAX_BYTES) {
      throw Object.assign(new Error('核心版本索引包含无效条目。'), { code: 'invalid-core-index' })
    }
    return release
  })
  return { ...index, releases }
}

async function loadReleaseIndex(serverUrl) {
  const url = new URL('core-release-index.json', normalizeServerUrl(serverUrl))
  const response = await readBoundedUrl(url, {
    timeoutMs: 15_000,
    maxBytes: INDEX_MAX_BYTES,
    headers: { accept: 'application/json' },
  })
  try {
    return validateReleaseIndex(JSON.parse(response.body.toString('utf8')))
  } catch (error) {
    if (error?.code === 'invalid-core-index') throw error
    throw Object.assign(new Error('核心版本索引不是有效 JSON。'), { code: 'invalid-core-index' })
  }
}

function newestCompatible(releases) {
  return releases
    .filter(release => release.compatibility === undefined
      || (typeof release.compatibility === 'object'
        && satisfies(TARGET_DSH_VERSION, release.compatibility.dsh ?? TARGET_DSH_VERSION)
        && (release.compatibility.os === undefined || release.compatibility.os.includes(process.platform))
        && (release.compatibility.arch === undefined || release.compatibility.arch.includes(process.arch))))
    .sort((left, right) => compareVersions(right.version, left.version))[0]
}

async function safeExtractCore(bytes, target) {
  const files = readZip(bytes)
  const manifestBytes = files.get('manifest.json')
  if (manifestBytes === undefined) {
    throw Object.assign(new Error('核心 ZIP 缺少 manifest.json。'), { code: 'invalid-core-archive' })
  }
  let manifest
  try {
    manifest = JSON.parse(manifestBytes.toString('utf8'))
  } catch {
    throw Object.assign(new Error('核心清单不是有效 JSON。'), { code: 'invalid-core-archive' })
  }
  if (!validateCoreManifest(manifest)) {
    throw Object.assign(new Error('核心清单版本、协议或 rc.2 兼容条件不符。'), { code: 'incompatible-core' })
  }
  const required = ['package.json', 'engine/index.js', 'page/index.html', 'page/app.js', 'page/styles.css']
  for (const name of required) {
    if (!files.has(name)) {
      throw Object.assign(new Error(`核心 ZIP 缺少 ${name}。`), { code: 'invalid-core-archive' })
    }
  }
  if (!files.has(manifest.entry) || !manifest.entry.startsWith('engine/')) {
    throw Object.assign(new Error('核心入口不在 engine/ 固定协议目录。'), { code: 'invalid-core-protocol' })
  }
  await mkdir(target, { recursive: true })
  for (const [name, content] of files) {
    const output = resolve(target, ...name.split('/'))
    if (!output.startsWith(resolve(target) + sep)) {
      throw Object.assign(new Error('核心 ZIP 路径越界。'), { code: 'unsafe-archive' })
    }
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, content, { flag: 'wx' })
  }
  return manifest
}

export class EngineSupervisor {
  constructor(ctx, {
    packageRoot,
    http = { readBoundedUrl },
    now = () => new Date().toISOString(),
  }) {
    this.ctx = ctx
    this.packageRoot = packageRoot
    this.root = join(dshHome(), 'capability-center')
    this.releasesRoot = join(this.root, 'releases')
    this.statePath = join(this.root, 'engine-state.json')
    this.http = http
    this.now = now
    this.engine = undefined
    this.fiber = undefined
    this.disposed = false
    this.stageQueue = Promise.resolve()
    this.ready = this.start()
  }

  async state() {
    return await readJson(this.statePath, {
      schemaVersion: 1,
      current: null,
      previous: null,
      pending: null,
      bootAttempt: null,
      lastFailure: null,
      updatedAt: this.now(),
    })
  }

  async writeState(state) {
    const value = { ...state, schemaVersion: 1, updatedAt: this.now() }
    await atomicWriteJson(this.statePath, value)
    return value
  }

  async ensureSeed() {
    const source = join(this.packageRoot, 'engine-seed')
    const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))
    if (!validateCoreManifest(manifest)) throw new Error('内置核心种子清单无效。')
    const target = join(this.releasesRoot, manifest.version)
    try {
      await readFile(join(target, 'manifest.json'))
    } catch {
      await mkdir(this.releasesRoot, { recursive: true })
      const staging = join(this.releasesRoot, `.seed-${randomUUID()}`)
      await cp(source, staging, { recursive: true, errorOnExist: true })
      await rename(staging, target)
    }
    return manifest
  }

  async start() {
    try {
      if (this.disposed) return { ready: false, error: 'supervisor-disposed' }
      const seed = await this.ensureSeed()
      let state = await this.state()
      if (state.current === null) {
        state = await this.writeState({ ...state, current: { version: seed.version, source: 'seed' } })
      }
      if (state.bootAttempt !== null && state.bootAttempt !== undefined) {
        const attempted = state.bootAttempt
        await removeQuietly(join(this.releasesRoot, attempted.version))
        state = await this.writeState({
          ...state,
          pending: state.pending?.version === attempted.version ? null : state.pending,
          bootAttempt: null,
          lastFailure: {
            version: attempted.version,
            message: '上次候选核心启动未完成，已隔离候选并回退当前健康核心。',
            at: this.now(),
          },
        })
      }
      if (state.pending !== null) {
        const candidate = state.pending
        state = await this.writeState({
          ...state,
          bootAttempt: {
            version: candidate.version,
            source: candidate.source ?? null,
            sha256: candidate.sha256 ?? null,
            fromVersion: state.current?.version ?? null,
            startedAt: this.now(),
          },
        })
        const activated = await this.tryActivate(candidate)
        if (activated) {
          state = await this.writeState({
            ...state,
            current: candidate,
            previous: state.current,
            pending: null,
            bootAttempt: null,
            lastFailure: null,
          })
        } else {
          await removeQuietly(join(this.releasesRoot, candidate.version))
          state = await this.writeState({
            ...state,
            pending: null,
            bootAttempt: null,
            lastFailure: {
              version: candidate.version,
              message: '候选核心启动失败，已回退到上一核心。',
              at: this.now(),
            },
          })
        }
      }
      if (this.disposed) return { ready: false, error: 'supervisor-disposed' }
      if (this.engine === undefined && state.current !== null) {
        const activated = await this.tryActivate(state.current)
        if (!activated && state.previous !== null) {
          const recovered = await this.tryActivate(state.previous)
          if (recovered) {
            state = await this.writeState({
              ...state,
              current: state.previous,
              previous: null,
              lastFailure: { version: state.current.version, message: '当前核心启动失败，已从上一核心恢复。', at: this.now() },
            })
          }
        }
      }
      if (this.engine === undefined) {
        const seedFallback = { version: seed.version, source: 'seed-fallback' }
        if (await this.tryActivate(seedFallback)) {
          state = await this.writeState({ ...state, current: seedFallback })
        }
      }
      return { ...state, ready: this.engine !== undefined }
    } catch (error) {
      return { ready: false, error: messageOf(error) }
    }
  }

  async tryActivate(entry) {
    if (this.disposed) return false
    if (entry === null || typeof entry?.version !== 'string') return false
    if (this.fiber !== undefined) {
      this.engine = undefined
      const oldFiber = this.fiber
      this.fiber = undefined
      await oldFiber.dispose?.()
    }
    const modulePath = join(this.releasesRoot, entry.version, 'engine', 'index.js')
    try {
      const manifest = JSON.parse(await readFile(join(this.releasesRoot, entry.version, 'manifest.json'), 'utf8'))
      if (!validateCoreManifest(manifest)) return false
      const moduleUrl = pathToFileURL(modulePath)
      moduleUrl.searchParams.set('v', `${manifest.version}-${randomUUID()}`)
      const module = await import(moduleUrl.href)
      if (typeof this.ctx.plugin !== 'function') {
        throw new Error('DSH rc.2 未提供 ctx.plugin，不能建立独立引擎生命周期。')
      }
      let candidateEngine
      const runtime = {
        version: manifest.version,
        dataRoot: this.root,
        http: this.http,
        setEngine: engine => { candidateEngine = engine },
      }
      const fiber = this.ctx.plugin(module, { runtime })
      try {
        await fiber.await()
      } catch (error) {
        await fiber.dispose?.()
        throw error
      }
      if (candidateEngine === undefined) {
        await fiber.dispose?.()
        throw new Error('核心没有完成服务注册。')
      }
      this.fiber = fiber
      this.engine = candidateEngine
      return true
    } catch (error) {
      this.engine = undefined
      if (this.ctx.logger?.warn) this.ctx.logger.warn(`能力中心核心 ${entry.version} 启动失败`, error)
      return false
    }
  }

  async check(serverUrl) {
    const index = await loadReleaseIndex(serverUrl)
    const state = await this.state()
    const currentVersion = this.engine?.version ?? state.current?.version ?? '0.0.0'
    const release = newestCompatible(index.releases)
    return {
      currentVersion,
      latestVersion: release?.version ?? null,
      updateAvailable: release !== undefined && compareVersions(release.version, currentVersion) > 0,
      pendingVersion: state.pending?.version ?? null,
      protocolVersion: CORE_PROTOCOL_VERSION,
      targetDsh: TARGET_DSH_VERSION,
    }
  }

  async stage(serverUrl) {
    const run = this.stageQueue.then(async () => {
      if (this.disposed) throw Object.assign(new Error('能力中心正在关闭。'), { code: 'disposed' })
      return await this.stageUnserialized(serverUrl)
    })
    this.stageQueue = run.catch(() => undefined)
    return await run
  }

  async stageUnserialized(serverUrl) {
    const index = await loadReleaseIndex(serverUrl)
    const state = await this.state()
    const currentVersion = this.engine?.version ?? state.current?.version ?? '0.0.0'
    const release = newestCompatible(index.releases)
    if (release === undefined) {
      throw Object.assign(new Error('内网服务器没有兼容当前 DSH 的核心版本。'), { code: 'incompatible-core' })
    }
    if (compareVersions(release.version, currentVersion) <= 0) {
      throw Object.assign(new Error('不执行相同版本或无提示降级；当前核心已是最新兼容版本。'), { code: 'not-newer' })
    }
    if (state.pending?.version === release.version) {
      return { staged: true, version: release.version, alreadyStaged: true }
    }
    const archiveUrl = new URL(release.archive, normalizeServerUrl(serverUrl))
    if (archiveUrl.origin !== new URL(normalizeServerUrl(serverUrl)).origin) {
      throw Object.assign(new Error('核心制品必须来自版本索引同一内网服务器。'), { code: 'cross-origin-artifact' })
    }
    const chunks = []
    const response = await this.http.readBoundedUrl(archiveUrl, {
      timeoutMs: 60_000,
      maxBytes: CORE_ARCHIVE_MAX_BYTES,
      headers: { accept: 'application/octet-stream' },
      onData: async chunk => { chunks.push(Buffer.from(chunk)) },
    })
    const bytes = response.body ?? Buffer.concat(chunks, response.bytes)
    const actualHash = sha256(bytes)
    if (actualHash !== release.sha256 || bytes.byteLength !== release.bytes) {
      throw Object.assign(new Error('核心 ZIP 的 SHA-256 或字节数不匹配。'), { code: 'hash-mismatch' })
    }
    const staging = join(this.releasesRoot, `.staging-${randomUUID()}`)
    let manifest
    try {
      manifest = await safeExtractCore(bytes, staging)
      if (manifest.version !== release.version) {
        throw Object.assign(new Error('ZIP 内版本与版本索引不一致。'), { code: 'version-mismatch' })
      }
      if (compareVersions(manifest.version, currentVersion) <= 0) {
        throw Object.assign(new Error('不执行核心降级。'), { code: 'not-newer' })
      }
      const target = join(this.releasesRoot, manifest.version)
      const markerPath = join(target, '.archive.json')
      const marker = {
        version: manifest.version,
        archive: release.archive,
        sha256: release.sha256,
        bytes: release.bytes,
      }
      // The marker is part of the staged tree. The final directory rename is
      // therefore the single commit point and cannot leave a marker-less
      // immutable version that every later publisher must reject.
      await atomicWriteJson(join(staging, '.archive.json'), marker)
      let existingMarker
      try {
        existingMarker = JSON.parse(await readFile(markerPath, 'utf8'))
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      if (existingMarker !== undefined) {
        if (existingMarker.sha256 !== release.sha256 || existingMarker.bytes !== release.bytes) {
          throw Object.assign(
            new Error(`核心 ${manifest.version} 已有不可变的另一份制品；发布时必须使用新的版本号。`),
            { code: 'release-immutable-conflict' },
          )
        }
        await removeQuietly(staging)
      } else {
        try {
          await readFile(join(target, 'manifest.json'))
          throw Object.assign(
            new Error(`核心 ${manifest.version} 已存在但没有发布标记；拒绝覆盖不可变版本。`),
            { code: 'release-immutable-conflict' },
          )
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
          await rename(staging, target)
        }
      }
      const next = await this.writeState({
        ...state,
        pending: {
          version: manifest.version,
          source: archiveUrl.href,
          sha256: release.sha256,
          stagedAt: this.now(),
        },
      })
      return {
        staged: true,
        version: manifest.version,
        currentVersion,
        restartRequired: true,
        pendingVersion: next.pending.version,
      }
    } catch (error) {
      await removeQuietly(staging)
      const before = await this.state()
      if (before.pending?.version === release.version && !(await this.releaseExists(release.version))) {
        await this.writeState({ ...before, pending: null })
      }
      throw error
    }
  }

  async releaseExists(version) {
    try {
      await readFile(join(this.releasesRoot, version, 'manifest.json'))
      return true
    } catch {
      return false
    }
  }

  async validateCandidateDirectory(version) {
    const root = join(this.releasesRoot, version)
    const manifest = JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8'))
    if (!validateCoreManifest(manifest) || manifest.version !== version) {
      throw new Error('候选核心清单无效。')
    }
    for (const path of ['engine/index.js', 'page/index.html', 'page/app.js', 'page/styles.css']) {
      await readFile(join(root, ...path.split('/')))
    }
    return manifest
  }

  async status() {
    const state = await this.state()
    return {
      ...state,
      activeVersion: this.engine?.version ?? null,
      ready: this.engine !== undefined,
      protocolVersion: CORE_PROTOCOL_VERSION,
      targetDsh: TARGET_DSH_VERSION,
    }
  }

  async handle(req, res, route, url) {
    await this.ready
    if (route === '/api/core/status') {
      if (this.engine !== undefined && await this.engine.handle(req, res, route, url)) return true
      await this.sendCoreStatus(res)
      return true
    }
    if (route === '/api/core/check') {
      const server = url.searchParams.get('server') ?? ''
      const result = await this.check(server)
      this.sendJson(res, 200, result)
      return true
    }
    if (route === '/api/core/stage') {
      const body = await this.bodyJson(req)
      const result = await this.stage(body.serverUrl)
      this.sendJson(res, 200, result)
      return true
    }
    if (this.engine !== undefined) return await this.engine.handle(req, res, route, url)
    if (route.startsWith('/api/')) {
      this.sendJson(res, 503, { code: 'core-unavailable', message: '核心引擎不可用，请在 DSH 重启后检查。' })
      return true
    }
    return false
  }

  async sendCoreStatus(res) {
    const status = await this.status()
    this.sendJson(res, status.ready ? 200 : 503, status)
  }

  sendJson(res, status, payload) {
    const body = Buffer.from(JSON.stringify(payload))
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-length', String(body.byteLength))
    res.setHeader('x-content-type-options', 'nosniff')
    res.end(body)
  }

  async bodyJson(req) {
    const essence = String(req.headers['content-type'] ?? '').split(';', 1)[0]?.trim().toLowerCase()
    if (essence !== 'application/json') {
      throw Object.assign(new Error('Content-Type 必须是 application/json。'), { status: 415 })
    }
    let size = 0
    const chunks = []
    for await (const chunk of req) {
      size += chunk.byteLength
      if (size > 32 * 1024) throw Object.assign(new Error('请求体过大。'), { status: 413 })
      chunks.push(Buffer.from(chunk))
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw Object.assign(new Error('请求体必须是 JSON 对象。'), { status: 400 })
    }
    return value
  }

  async dispose() {
    this.disposed = true
    await this.ready.catch(() => undefined)
    await this.stageQueue.catch(() => undefined)
    this.engine = undefined
    const fiber = this.fiber
    this.fiber = undefined
    await fiber?.dispose?.()
  }
}
