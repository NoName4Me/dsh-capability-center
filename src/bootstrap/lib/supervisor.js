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
import { assertTrustedSource, trustedPayload } from './signature.js'
import { compareVersions, parseVersion, satisfies } from './semver.js'

export const CORE_PROTOCOL_VERSION = 1
export const CORE_PACKAGE_NAME = 'capability-center-core'
export const TARGET_DSH_VERSION = '0.2.1-rc.2'
const INDEX_MAX_BYTES = 1024 * 1024
const CORE_ARCHIVE_MAX_BYTES = 32 * 1024 * 1024
const DEV_DISTRIBUTION_META_ENV = 'CAPABILITY_CENTER_DEV_DISTRIBUTION_URL'
const DEV_SEED_ENV = 'CAPABILITY_CENTER_DEV_SEED'
const FEEDBACK_EMAIL_ENV = 'CAPABILITY_CENTER_FEEDBACK_EMAIL'

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

export function normalizeDevDistributionUrl(raw) {
  const value = String(raw ?? '').trim()
  if (value === '') return undefined
  let url
  try {
    url = new URL(value)
    if (url.protocol !== 'http:'
      || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.port === '') {
      throw new Error('invalid')
    }
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`
  } catch {
    throw Object.assign(new Error('开发分发地址必须是带端口的本机回环 HTTP URL。'), {
      code: 'invalid-dev-distribution-url',
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
  const base=normalizeServerUrl(serverUrl)
  assertTrustedSource(base)
  const url = new URL('core-release-index.json', base)
  const response = await readBoundedUrl(url, {
    timeoutMs: 15_000,
    maxBytes: INDEX_MAX_BYTES,
    headers: { accept: 'application/json' },
  })
  try {
    return validateReleaseIndex(await trustedPayload(JSON.parse(response.body.toString('utf8'))))
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
    devSeed = process.env[DEV_SEED_ENV] === '1',
    devDistributionUrl = normalizeDevDistributionUrl(process.env[DEV_DISTRIBUTION_META_ENV]),
    feedbackEmail = process.env[FEEDBACK_EMAIL_ENV],
  }) {
    this.ctx = ctx
    this.packageRoot = packageRoot
    this.root = join(dshHome(), 'capability-center')
    this.releasesRoot = join(this.root, 'releases')
    this.statePath = join(this.root, 'engine-state.json')
    this.http = http
    this.now = now
    this.devSeed = devSeed
    this.devDistributionUrl = devDistributionUrl
    this.engine = undefined
    this.fiber = undefined
    this.disposed = false
    this.lifecycleQueue = Promise.resolve()
    this.inFlightHandles = new Set()
    this.seed = undefined
    this.feedbackEmail = typeof feedbackEmail === 'string' && feedbackEmail.trim() !== ''
      ? feedbackEmail.trim()
      : undefined
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
    if (this.devSeed) return manifest
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
      if (this.feedbackEmail === undefined) {
        try {
          const packaged = JSON.parse(await readFile(
            join(this.packageRoot, 'feedback-config.json'),
            'utf8',
          ))
          if (typeof packaged.feedbackEmail === 'string' && packaged.feedbackEmail.trim() !== '') {
            this.feedbackEmail = packaged.feedbackEmail.trim()
          }
        } catch {
          // Feedback email configuration is optional.
        }
      }
      const seed = await this.ensureSeed()
      this.seed = seed
      let state = await this.state()
      const seedSource = this.devSeed ? 'dev-seed' : 'seed'
      if (state.current === null
        || (this.devSeed
          && state.current.version === seed.version
          && ['seed', 'seed-fallback', 'dev-seed'].includes(state.current.source))) {
        state = await this.writeState({
          ...state,
          current: { version: seed.version, source: seedSource },
        })
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
      const currentVersion = state.current?.version ?? '0.0.0'
      const pendingVersion = state.pending?.version ?? '0.0.0'
      if (compareVersions(seed.version, currentVersion) > 0
        && state.lastFailure?.version !== seed.version
        && (state.pending === null || compareVersions(seed.version, pendingVersion) > 0)) {
        state = await this.writeState({
          ...state,
          pending: {
            version: seed.version,
            source: seedSource,
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
        const activated = await this.tryActivate(
          candidate,
          this.activationRoot(candidate, seed),
        )
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
        const seedRoot = this.activationRoot(state.current, seed)
        const activated = await this.tryActivate(state.current, seedRoot)
        if (!activated && state.previous !== null) {
          const recovered = await this.tryActivate(
            state.previous,
            this.activationRoot(state.previous, seed),
          )
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
        const seedFallback = {
          version: seed.version,
          source: this.devSeed ? 'dev-seed' : 'seed-fallback',
        }
        const seedRoot = this.devSeed ? join(this.packageRoot, 'engine-seed') : undefined
        if (await this.tryActivate(seedFallback, seedRoot)) {
          state = await this.writeState({ ...state, current: seedFallback })
        }
      }
      return { ...state, ready: this.engine !== undefined }
    } catch (error) {
      return { ready: false, error: messageOf(error) }
    }
  }

  activationRoot(entry, seed) {
    if (this.devSeed
      && entry.version === seed.version
      && ['dev-seed', 'seed', 'seed-fallback'].includes(entry.source)) {
      return join(this.packageRoot, 'engine-seed')
    }
    return undefined
  }

  async tryActivate(entry, sourceRoot) {
    if (this.disposed) return false
    await this.disposeCurrentEngine()
    return (await this.launchCore(entry, sourceRoot)).ok
  }

  async launchCore(entry, sourceRoot) {
    if (this.disposed) return { ok: false, error: '能力中心监督器正在关闭。' }
    if (entry === null || typeof entry?.version !== 'string') {
      return { ok: false, error: '核心版本记录无效。' }
    }
    const releaseRoot = sourceRoot ?? join(this.releasesRoot, entry.version)
    const modulePath = join(releaseRoot, 'engine', 'index.js')
    let fiber
    let disposed = false
    const disposeCandidate = async () => {
      if (disposed || fiber === undefined) return
      disposed = true
      try {
        await fiber.dispose?.()
      } catch {
        // A failed candidate must not mask the original startup error.
      }
    }
    try {
      const manifest = JSON.parse(await readFile(join(releaseRoot, 'manifest.json'), 'utf8'))
      if (!validateCoreManifest(manifest) || manifest.version !== entry.version) {
        return { ok: false, error: `核心 ${entry.version} 的清单无效。` }
      }
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
        devDistributionUrl: this.devDistributionUrl,
        setEngine: engine => { candidateEngine = engine },
        coreCheck: serverUrl => this.check(serverUrl),
        coreStatus: () => this.status(),
        feedbackEmail: this.feedbackEmail,
        refreshBridge: {
          reload: true,
          overlay: true,
          coreActivation: true,
          nativeRestart: this.desktopRestartActions() !== undefined,
        },
      }
      fiber = this.ctx.plugin(module, { runtime })
      try {
        await fiber.await()
      } catch (error) {
        throw error
      }
      if (candidateEngine === undefined) {
        throw new Error('核心没有完成服务注册。')
      }
      if (typeof candidateEngine.verify === 'function') {
        const verified = await candidateEngine.verify()
        if (verified?.ready !== true || verified?.version !== manifest.version) {
          throw new Error('核心健康检查没有确认当前版本已就绪。')
        }
      }
      this.fiber = fiber
      this.engine = candidateEngine
      return { ok: true }
    } catch (error) {
      if (this.engine !== undefined) this.engine = undefined
      if (this.fiber !== undefined) this.fiber = undefined
      await disposeCandidate()
      if (this.ctx.logger?.warn) this.ctx.logger.warn(`能力中心核心 ${entry.version} 启动失败`, error)
      return { ok: false, error: messageOf(error) }
    }
  }

  async disposeCurrentEngine() {
    const engine = this.engine
    const fiber = this.fiber
    this.engine = undefined
    this.fiber = undefined
    engine?.stopAcceptingWork?.()
    try {
      await engine?.drain?.()
    } catch {
      // Disposal continues so the old fiber cannot retain registered services.
    }
    try {
      await fiber?.dispose?.()
    } catch {
      // The caller reports recovery from the replacement core, not cleanup noise.
    }
  }

  async drainInFlightHandles() {
    while (this.inFlightHandles.size > 0) {
      await Promise.allSettled([...this.inFlightHandles])
    }
  }

  enqueueLifecycle(callback) {
    const run = this.lifecycleQueue.then(callback)
    this.lifecycleQueue = run.catch(() => undefined)
    return run
  }

  async activatePending(expectedVersion) {
    const before = await this.state()
    const candidate = before.pending
    if (candidate === null) {
      throw Object.assign(new Error('当前没有已暂存的核心。'), {
        code: 'no-pending-core',
        status: 409,
      })
    }
    if (expectedVersion !== undefined && candidate.version !== expectedVersion) {
      throw Object.assign(new Error('已暂存核心已被另一个窗口更改，请刷新当前状态后重试。'), {
        code: 'pending-core-changed',
        status: 409,
        expectedVersion,
        pendingVersion: candidate.version,
      })
    }
    const previous = before.current
    const manifest = await this.validateCandidateDirectory(candidate.version)
    if (previous === null) {
      throw Object.assign(new Error('没有可回退的当前核心，拒绝原位切换。'), {
        code: 'no-previous-core',
        status: 409,
      })
    }
    const bootAttemptState = await this.writeState({
      ...before,
      bootAttempt: {
        version: candidate.version,
        source: candidate.source ?? null,
        sha256: candidate.sha256 ?? null,
        fromVersion: previous.version,
        startedAt: this.now(),
        mode: 'hot-activation',
      },
    })
    try {
      this.engine?.stopAcceptingWork?.()
      await this.engine?.drain?.()
      await this.drainInFlightHandles()
      await this.disposeCurrentEngine()
      const launched = await this.launchCore(candidate)
      if (!launched.ok) {
        throw new Error(launched.error || '候选核心启动失败。')
      }
      const next = await this.writeState({
        ...bootAttemptState,
        current: candidate,
        previous,
        pending: null,
        bootAttempt: null,
        lastFailure: null,
      })
      return {
        activated: true,
        activeVersion: manifest.version,
        version: manifest.version,
        previousVersion: previous.version,
        state: next,
      }
    } catch (error) {
      await this.disposeCurrentEngine()
      const rollback = await this.launchCore(previous, this.activationRoot(previous, this.seed))
      const current = await this.state().catch(() => before)
      if (rollback.ok) {
        await removeQuietly(join(this.releasesRoot, candidate.version))
      }
      await this.writeState({
        ...current,
        pending: rollback.ok ? null : current.pending ?? candidate,
        bootAttempt: rollback.ok ? null : current.bootAttempt,
        lastFailure: {
          version: candidate.version,
          message: `运行时切换失败：${messageOf(error)}`,
          at: this.now(),
        },
      }).catch(() => undefined)
      const suffix = rollback.ok ? '已回退当前健康核心。' : '当前健康核心也无法恢复，请重启 DSH。'
      throw Object.assign(new Error(`${messageOf(error)} ${suffix}`), {
        code: 'core-activation-failed',
        status: 500,
        rolledBack: rollback.ok,
        attemptedVersion: candidate.version,
      })
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
    return await this.enqueueLifecycle(async () => {
      if (this.disposed) throw Object.assign(new Error('能力中心正在关闭。'), { code: 'disposed' })
      return await this.stageUnserialized(serverUrl)
    })
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
        refreshRequired: true,
        restartRequired: false,
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

  async dispatchEngine(req, res, route, url) {
    const engine = this.engine
    if (engine === undefined) return false
    const task = Promise.resolve().then(() => engine.handle(req, res, route, url))
    this.inFlightHandles.add(task)
    try {
      return await task
    } finally {
      this.inFlightHandles.delete(task)
    }
  }

  async handle(req, res, route, url) {
    await this.ready
    if (route === '/api/host/restart') {
      if (req.method !== 'POST') {
        this.sendJson(res, 405, { message: '重启只接受 POST。' })
        return true
      }
      const address = req.socket?.remoteAddress
      if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) {
        this.sendJson(res, 403, { message: '请在 DSH 桌面端请求重启。' })
        return true
      }
      const actions = this.desktopRestartActions()
      if (actions === undefined) {
        this.sendJson(res, 501, { message: '当前宿主不提供一键重启，请退出并重新打开 DSH。' })
        return true
      }
      const body = await this.bodyJson(req)
      if (body.confirm !== true) {
        this.sendJson(res, 400, { message: '请先确认重启。' })
        return true
      }
      await this.lifecycleQueue
      if (this.engine?.hasPendingActions?.()) {
        this.sendJson(res, 409, { message: '请等能力安装或更新结束后再重启。' })
        return true
      }
      if (!this.restartRequested) {
        this.restartRequested = true
        res.once('finish', () => {
          setTimeout(async () => {
            try {
              await actions.requestRestart()
            } catch (error) {
              this.ctx.logger?.warn?.('能力中心请求 DSH 重启失败', error)
            } finally {
              this.restartRequested = false
            }
          }, 150).unref()
        })
      }
      this.sendJson(res, 202, { requested: true })
      return true
    }
    if (route === '/api/core/activate') {
      if (req.method !== 'POST') {
        this.sendJson(res, 405, { code: 'method-not-allowed', message: '核心切换只接受 POST。' })
        return true
      }
      const body = await this.bodyJson(req)
      if (typeof body.version !== 'string'
        || parseVersion(body.version) === null) {
        this.sendJson(res, 400, {
          code: 'version-required',
          message: '核心切换必须确认当前页面看到的待激活版本。',
        })
        return true
      }
      const result = await this.enqueueLifecycle(() => this.activatePending(body.version))
      this.sendJson(res, 200, {
        activated: result.activated,
        activeVersion: result.activeVersion,
        version: result.version,
        previousVersion: result.previousVersion,
        rolledBack: false,
      })
      return true
    }
    await this.lifecycleQueue
    if (route === '/api/core/status') {
      if (await this.dispatchEngine(req, res, route, url)) return true
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
    if (await this.dispatchEngine(req, res, route, url)) return true
    if (route.startsWith('/api/')) {
      this.sendJson(res, 503, { code: 'core-unavailable', message: '核心引擎不可用，请在 DSH 重启后检查。' })
      return true
    }
    return false
  }

  desktopRestartActions() {
    const actions = this.ctx.get?.('desktopActions')
    return typeof actions?.requestRestart === 'function' ? actions : undefined
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
    await this.lifecycleQueue.catch(() => undefined)
    await this.drainInFlightHandles()
    await this.disposeCurrentEngine()
  }
}
