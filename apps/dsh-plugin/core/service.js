import { execFile } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import {
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { readJson, atomicWriteJson } from './lib/atomic.js'
import { readZip, safeRelativePath } from './lib/archive.js'
import { planCapabilities, validateGraph } from './lib/graph.js'
import {
  CapabilityError,
  compatibilityError,
  itemById,
  normalizeServerUrl,
  serializableItem,
  validateCatalog,
} from './lib/manifest.js'
import { compareVersions } from './lib/semver.js'
import { LocalLedger } from './lib/ledger.js'
import { CatalogSync } from './lib/catalog-sync.js'
import { prepareRuntime, verifyRuntime, removeRuntime } from './lib/runtime.js'
import {
  downloadArtifact,
  installPython,
  installSkill,
  rollbackPython,
  rollbackPythonUninstall,
  rollbackLegacyPythonUninstall,
  rollbackSkill,
  rollbackSkillUninstall,
  uninstallPython,
  removeOwnedTree,
  moveVerifiedFiles,
  verifyOwnedFiles,
  collectDirectoryFiles,
} from './lib/installers.js'

const runFile = promisify(execFile)
const TERMINAL = new Set(['ready', 'restart-required', 'failed'])
const REQUEST_ID = /^[A-Za-z0-9_-]{8,96}$/u
const MAX_PROMPT_LENGTH = 4_000
const FEEDBACK_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u
const LEGACY_IDS = new Set(['report-format', 'dsh-local-sysinfo', 'python-tabulate'])
const AUTO_CONTINUE_ID = 'dsh-intranet-auto-continue'
const OFFICE_ROOT_ID = 'office-enhancement'
const OFFICE_SKILL_ID = 'office-enhancement-skill'
const PYPDF_ID = 'python-pypdf'
const PYPDF_VERSION = '7.1.0'
const PYPDF_WHEEL_SHA256 = '47cca6b24bdcf4c4d65b5f7b8b972535c61710a061261e737688777cfd9a7bfb'
const OFFICE_SMOKE_SHA256 = '619e5915e526d269f0425bbfb92f4b01f7567fd4d6b0c55cd95dd2d65c7a4698'
const OFFICE_TOOLS_SHA256 = '8300aacaa7cc5546e9702addcc554e279d50e3cafd4b70fda4b689f478f1baea'
const OFFICE_SMOKE_PATH = 'scripts/office_smoke.py'
const OFFICE_TOOLS_PATH = 'scripts/office_tools.py'
const ENGINE_ROOT = dirname(fileURLToPath(import.meta.url))
const PAGE_ROOT = join(dirname(ENGINE_ROOT), 'page')
const STATIC = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/icon.svg', ['icon.svg', 'image/svg+xml']],
])

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function dshHome() {
  const configured = String(process.env.DSH_HOME ?? '').trim()
  return configured === '' ? join(homedir(), '.dsh') : configured
}

function skillName(raw) {
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)
  if (frontmatter === null) throw new CapabilityError('invalid-skill', 'SKILL.md 缺少 frontmatter。')
  return {
    name: /^name:\s*([^\r\n]+)$/mu.exec(frontmatter[1])?.[1]?.trim(),
    description: /^description:\s*([^\r\n]+)$/mu.exec(frontmatter[1])?.[1]?.trim(),
    content: raw.slice(frontmatter[0].length).trim(),
  }
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function recordsByPath(records) {
  return new Map(records.map(record => [record.path, record]))
}

function exactRecordsMatch(expected, actual) {
  const expectedByPath = recordsByPath(expected)
  const actualByPath = recordsByPath(actual)
  if (expectedByPath.size !== actualByPath.size) return false
  for (const [path, record] of expectedByPath) {
    const candidate = actualByPath.get(path)
    if (candidate?.bytes !== record.bytes || candidate?.sha256 !== record.sha256) return false
  }
  return true
}

function skillArchiveRecords(item, bytes) {
  const prefix = `${item.id}/`
  const records = []
  for (const [path, content] of readZip(bytes)) {
    if (!path.startsWith(prefix)) {
      throw new CapabilityError('unsafe-archive', `技能包包含固定目录之外的路径：${path}`)
    }
    const relative = path.slice(prefix.length)
    if (!safeRelativePath(relative)) {
      throw new CapabilityError('unsafe-path', `技能路径不安全：${relative}`)
    }
    records.push({
      path: relative,
      bytes: content.byteLength,
      sha256: sha256(content),
    })
  }
  if (!records.some(record => record.path === 'SKILL.md')) {
    throw new CapabilityError('invalid-skill', '技能包缺少 SKILL.md。')
  }
  return records.sort((left, right) => left.path.localeCompare(right.path))
}

function wheelRecords(item, bytes) {
  if (sha256(bytes) !== PYPDF_WHEEL_SHA256) {
    throw new CapabilityError('hash-mismatch', 'pypdf wheel 与核心固定的可信 SHA-256 不一致。')
  }
  const files = readZip(bytes)
  const distInfo = `${item.install.distribution}-${item.version}.dist-info`
  const recordBytes = files.get(`${distInfo}/RECORD`)
  if (recordBytes === undefined) {
    throw new CapabilityError('invalid-wheel', 'pypdf wheel 缺少 RECORD。')
  }
  const records = []
  for (const line of recordBytes.toString('utf8').split(/\r?\n/u)) {
    if (!line) continue
    const [path, encoded] = line.split(',', 2)
    if (!safeRelativePath(path) || !files.has(path)) {
      throw new CapabilityError('invalid-wheel', `pypdf RECORD 路径无效：${path}`)
    }
    if (encoded !== '') {
      const match = /^sha256=([A-Za-z0-9_-]{43})$/u.exec(encoded)
      if (match === null) {
        throw new CapabilityError('invalid-wheel', `pypdf RECORD 哈希无效：${path}`)
      }
      const digest = Buffer.from(match[1], 'base64url').toString('hex')
      if (digest !== sha256(files.get(path))) {
        throw new CapabilityError('invalid-wheel', `pypdf RECORD 哈希不匹配：${path}`)
      }
      records.push({ path, bytes: files.get(path).byteLength, sha256: digest })
    }
  }
  return records.sort((left, right) => left.path.localeCompare(right.path))
}

function samePath(left, right) {
  const a = resolve(String(left))
  const b = resolve(String(right))
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
}

function legacyManifest(type, id, version) {
  const descriptions = {
    'report-format': '报告格式',
    'dsh-local-sysinfo': '本机系统信息',
    'python-tabulate': 'Tabulate',
  }
  const name = descriptions[id] ?? id
  const common = {
    id,
    type,
    name,
    version,
    description: `从旧版能力中心检测到的 ${name} ${version}。`,
    compatibility: {},
    dependencies: [],
    usage: {
      steps: ['检查本机状态。', '需要时使用“检查与修复”。'],
      inputs: '按能力自身说明提供输入。',
      output: '能力自身输出。',
      example: '查看能力详情。',
    },
    trial: { prompt: `请检查已安装能力 ${name} 的可用状态，并告诉我可以如何使用。` },
    checks: type === 'skill'
      ? [{ type: 'skill-discovery', name: id }]
      : type === 'plugin'
        ? [{ type: 'named-tool-readonly-call', tool: 'get_local_system_info' }]
        : [{ type: 'python-import', module: 'tabulate', version }],
    legacy: true,
  }
  if (type === 'plugin') common.install = { packageName: id }
  if (type === 'python') common.install = { distribution: 'tabulate', module: 'tabulate', wheelTag: 'py3-none-any' }
  return common
}

function localDisplayItem(entry) {
  const source = typeof entry.manifest === 'object' && entry.manifest !== null
    ? entry.manifest
    : {}
  const boundedText = (value, fallback, limit) =>
    typeof value === 'string' && value.trim() !== '' ? value.slice(0, limit) : fallback
  const dependencies = Array.isArray(source.dependencies)
    ? source.dependencies
      .filter(value => typeof value?.id === 'string' && typeof value?.version === 'string')
      .slice(0, 32)
      .map(value => ({ id: value.id, version: value.version }))
    : []
  const checks = Array.isArray(source.checks)
    ? source.checks.filter(value => typeof value?.type === 'string').slice(0, 8)
    : []
  const usage = typeof source.usage === 'object' && source.usage !== null
    ? {
        steps: Array.isArray(source.usage.steps)
          ? source.usage.steps.filter(value => typeof value === 'string').slice(0, 8)
          : [],
        inputs: boundedText(source.usage.inputs, '按能力自身说明提供输入。', 1_200),
        output: boundedText(source.usage.output, '能力自身输出。', 1_200),
        example: boundedText(source.usage.example, '查看能力详情。', 2_400),
      }
    : {
        steps: ['检查本机状态。', '需要时使用“检查与修复”。'],
        inputs: '按能力自身说明提供输入。',
        output: '能力自身输出。',
        example: '查看能力详情。',
      }
  const prompt = typeof source.trial?.prompt === 'string'
    && source.trial.prompt.trim() !== ''
    && source.trial.prompt.length <= MAX_PROMPT_LENGTH
    && !source.trial.prompt.includes('\0')
    ? source.trial.prompt
    : `请检查已安装能力 ${boundedText(source.name, entry.id, 100)} 的可用状态，并说明如何使用。`
  return {
    id: entry.id,
    type: entry.type,
    name: boundedText(source.name, entry.id, 100),
    version: entry.version,
    description: boundedText(source.description, '本机账本中的已安装能力。', 1_200),
    compatibility: {},
    dependencies,
    checks,
    usage,
    trial: { prompt },
    install: source.install,
    hidden: source.hidden === true,
    category: source.category === 'mcp' ? 'mcp' : undefined,
    legacy: entry.legacy === true,
    localOnly: true,
  }
}

export class CoreService {
  constructor(ctx, runtime) {
    this.ctx = ctx
    this.runtime = runtime
    this.version = runtime.version
    this.dataRoot = runtime.dataRoot
    this.home = runtime.dshHome ?? dshHome()
    this.ledger = new LocalLedger(this.dataRoot)
    this.catalogSync = new CatalogSync(this.dataRoot, runtime.http)
    this.coreUpdateCache = new Map()
    this.syncTimer = undefined
    this.operations = new Map()
    this.queue = Promise.resolve()
    this.disposed = false
    this.trials = new Map()
    this.skillDisposers = new Map()
    this.recoveryRequired = false
    this.recoveryMessages = []
    this.legacyManagerEnabled = false
    this.faultInjection = runtime.faultInjection
    this.devDistributionUrl = runtime.devDistributionUrl
    this.acceptingWork = true
    this.feedbackEmail = typeof runtime.feedbackEmail === 'string'
      && runtime.feedbackEmail.length <= 254
      && FEEDBACK_EMAIL.test(runtime.feedbackEmail.trim())
      ? runtime.feedbackEmail.trim()
      : undefined
    this.initialized = false
  }

  async initialize() {
    try {
      await mkdir(this.dataRoot, { recursive: true })
      await this.ledger.open()
      await this.recoverInterrupted()
      if (this.recoveryRequired) return
      await this.migrateLegacy()
      await this.syncAllSkills()
      await this.refreshRestartRequired()
      await this.catalogSync.initialize().catch(() => undefined)
      this.scheduleCatalogSync(0)
    } finally {
      this.initialized = true
    }
  }

  verify() {
    if (this.disposed || !this.initialized || !this.acceptingWork) {
      throw new Error('核心服务尚未完成初始化或已经停止。')
    }
    return { ready: true, version: this.version }
  }

  stopAcceptingWork() {
    this.acceptingWork = false
    clearTimeout(this.syncTimer)
  }

  async drain() {
    await this.queue.catch(() => undefined)
  }

  async recoverInterrupted() {
    const journals = await this.ledger.pending()
    const unresolved = journals.filter(journal =>
      journal.phase === 'unreadable' || journal.recoveryRequired === true)
    if (unresolved.length > 0) {
      this.recoveryRequired = true
      for (const journal of unresolved) {
        this.recoveryMessages.push(
          `${journal.operationId}: 操作日志无法解析或此前恢复未完成；已保留现场并停止自动修改`,
        )
      }
      return
    }
    for (const journal of journals) {
      if (journal.phase === 'ledger-committed' || journal.phase === 'committed') {
        await this.ledger.close(journal.operationId)
        continue
      }
      try {
        const rollback = journal.rollback ?? {}
        const intents = Array.isArray(journal.intents) ? journal.intents : []
        for (const intent of [...intents].reverse()) {
          await this.recoverIntent(intent)
        }
        if (rollback.skill !== undefined) await rollbackSkill(rollback.skill)
        if (rollback.python !== undefined) await rollbackPython(rollback.python)
        if (journal.beforeLedger !== undefined) {
          this.ledger.restore(journal.beforeLedger)
          await this.ledger.write()
        }
        await this.ledger.close(journal.operationId)
      } catch (error) {
        this.recoveryRequired = true
        this.recoveryMessages.push(`${journal.operationId}: ${messageOf(error)}`)
        await this.ledger.updateJournal(journal.operationId, {
          phase: 'recovery-required',
          recoveryRequired: true,
          recoveryError: messageOf(error),
        }).catch(() => undefined)
      }
    }
  }

  async fault(label, details = {}) {
    if (typeof this.faultInjection !== 'function') return
    const action = await this.faultInjection(label, details)
    if (action === 'crash') {
      throw Object.assign(new Error(`注入故障：${label}`), {
        code: 'SIMULATED_CRASH',
        simulatedCrash: true,
      })
    }
  }

  async installedBundle(packageName) {
    const manager = this.pluginManager()
    if (typeof manager?.listBundles !== 'function') {
      throw new CapabilityError('recovery-unverifiable', 'DSH 未提供 listBundles，无法确认插件恢复结果。')
    }
    const bundles = await manager.listBundles()
    return bundles.find(bundle => bundle.name === packageName)
  }

  async removePluginForRecovery(packageName) {
    const manager = this.pluginManager()
    const current = await this.installedBundle(packageName)
    if (current?.installed !== true) return
    const result = await manager.removeBundle(packageName)
    if (!['applied', 'restart-required'].includes(result?.application)) {
      throw new CapabilityError(
        'recovery-remove-failed',
        `恢复时移除插件 ${packageName} 未得到可信结果：${result?.error?.diagnostic ?? result?.application ?? '无结果'}`,
      )
    }
    const after = await this.installedBundle(packageName)
    if (after?.installed === true || after?.enabled === true) {
      throw new CapabilityError('recovery-remove-unverified', `插件 ${packageName} 移除后仍被 profile 记录。`)
    }
  }

  async recoverIntent(intent) {
    if(intent.kind==='runtime-create'){await removeRuntime(this.dataRoot,intent);return}
    if (intent.kind === 'skill') {
      await rollbackSkill(intent)
      return
    }
    if (intent.kind === 'python') {
      await rollbackPython(intent)
      return
    }
    if (intent.kind === 'skill-uninstall') {
      await rollbackSkillUninstall(intent)
      return
    }
    if (intent.kind === 'python-uninstall') {
      await rollbackPythonUninstall(intent)
      return
    }
    if (intent.kind === 'legacy-python-uninstall') {
      await rollbackLegacyPythonUninstall(intent)
      return
    }
    if (intent.kind === 'plugin-install') {
      await this.removePluginForRecovery(intent.packageName)
      return
    }
    if (intent.kind === 'plugin-remove') {
      if (typeof intent.beforeArchive !== 'string' || intent.beforeArchive === '') {
        throw new CapabilityError(
          'recovery-artifact-missing',
          `插件 ${intent.packageName} 缺少旧版缓存，无法证明恢复到 ${intent.beforeVersion ?? '原版本'}。`,
        )
      }
      const manager = this.pluginManager()
      const current = await this.installedBundle(intent.packageName)
      if (current?.installed === true && current.version === intent.beforeVersion) return
      if (current?.installed === true) await this.removePluginForRecovery(intent.packageName)
      const restored = await manager.installBundle(intent.beforeArchive, this.pluginInstallOptions())
      if (!['applied', 'restart-required', 'overridden'].includes(restored?.application)) {
        throw new CapabilityError(
          'recovery-install-failed',
          `恢复插件 ${intent.packageName} 失败：${restored?.error?.diagnostic ?? restored?.application ?? '无结果'}`,
        )
      }
      const after = await this.installedBundle(intent.packageName)
      if (after?.installed !== true || (intent.beforeVersion !== undefined && after.version !== intent.beforeVersion)) {
        throw new CapabilityError(
          'recovery-install-unverified',
          `插件 ${intent.packageName} 恢复后版本与账本不一致。`,
        )
      }
      return
    }
    throw new CapabilityError('recovery-intent-unknown', `未知恢复意图：${intent.kind}`)
  }

  async rollbackJournalIntents(journal) {
    const errors = []
    for (const intent of [...(journal.intents ?? [])].reverse()) {
      try {
        await this.recoverIntent(intent)
      } catch (error) {
        errors.push(`${intent.itemId ?? intent.packageName ?? intent.kind}: ${messageOf(error)}`)
      }
    }
    if (errors.length > 0) {
      throw Object.assign(new CapabilityError('rollback-incomplete', errors.join('；')), {
        rollbackErrors: errors,
      })
    }
  }

  async latestJournal(operationId) {
    const journal = await readJson(this.ledger.journalPath(operationId))
    if (journal === undefined) {
      throw new CapabilityError('journal-missing', '安装操作日志已丢失，无法证明磁盘变更已回滚。')
    }
    return journal
  }

  async migrateLegacy() {
    try {
      const bundles = await this.ctx.pluginManager?.listBundles?.()
      this.legacyManagerEnabled = bundles?.some(bundle =>
        bundle.name === 'capability-center-demo' && (bundle.enabled === true || bundle.installed === true)) === true
    } catch {
      this.legacyManagerEnabled = false
    }
    const receiptsRoot = join(this.dataRoot, 'installed')
    let names = []
    try { names = await readdir(receiptsRoot) } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
    for (const name of names.filter(name => name.endsWith('.json'))) {
      const receiptId = basename(name, '.json')
      if (this.ledger.hasMigrationTombstone(receiptId)) continue
      if (this.ledger.get(receiptId) !== undefined) continue
      try {
        const receipt = JSON.parse(await readFile(join(receiptsRoot, name), 'utf8'))
        if (!LEGACY_IDS.has(receipt.id) || !['skill', 'python'].includes(receipt.type)) continue
        if (typeof receipt.version !== 'string' || typeof receipt.root !== 'string') continue
        const manifest = legacyManifest(receipt.type, receipt.id, receipt.version)
        let runtimeRoot
        let pythonPackages
        if (receipt.type === 'skill') {
          const skillsRoot = join(this.home, 'skills')
          if (!samePath(receipt.root, skillsRoot)) continue
          runtimeRoot = receipt.target ?? join(skillsRoot, receipt.id)
          if (receipt.target !== undefined && !samePath(receipt.target, runtimeRoot)) continue
          if (!isAbsolute(receipt.target ?? runtimeRoot)
            || !samePath(receipt.target ?? runtimeRoot, join(skillsRoot, receipt.id))) continue
        } else {
          const recordedPythonPackages = receipt.pythonPackages ?? receipt.root
          if (!isAbsolute(recordedPythonPackages)) continue
          if (receipt.pythonPackages !== undefined && !samePath(receipt.pythonPackages, receipt.root)) continue
          runtimeRoot = recordedPythonPackages
          pythonPackages = recordedPythonPackages
        }
        await this.ledger.setEntry({
          id: receipt.id,
          type: receipt.type,
          version: receipt.version,
          source: 'legacy-demo',
          manifest,
          ownedFiles: Array.isArray(receipt.records)
            ? receipt.records.map(record => ({
              ...record,
              path: record.path.startsWith(`${receipt.id}/`) ? record.path.slice(receipt.id.length + 1) : record.path,
            }))
            : [],
          runtimeRoot,
          pythonPackages,
          legacy: true,
          preexisting: false,
          rootInstalled: true,
          dependencyOwners: [],
          latestHealth: { status: 'unknown', detail: '旧版安装已导入，等待检查' },
          lastOperation: 'legacy-import',
        })
      } catch {
        // A corrupt old receipt stays untouched and is not adopted.
      }
    }
    if (this.ledger.get('dsh-local-sysinfo') === undefined) {
      try {
        const bundles = await this.ctx.pluginManager?.listBundles?.()
        if (bundles?.some(bundle => bundle.name === 'dsh-local-sysinfo' && bundle.installed)) {
          await this.ledger.setEntry({
            id: 'dsh-local-sysinfo',
            type: 'plugin',
            version: bundles.find(bundle => bundle.name === 'dsh-local-sysinfo').version ?? '1.0.0',
            source: 'legacy-demo',
            manifest: legacyManifest('plugin', 'dsh-local-sysinfo', '1.0.0'),
            artifacts: [],
            legacy: true,
            preexisting: true,
            rootInstalled: true,
            dependencyOwners: [],
            latestHealth: { status: 'unknown', detail: '旧版插件已从 DSH profile 导入' },
            lastOperation: 'legacy-import',
          })
        }
      } catch {
        // Profile inventory may be temporarily unavailable.
      }
    }
  }

  skillRegistry() {
    return this.ctx.skills ?? this.ctx.get?.('skills')
  }

  pluginManager() {
    return this.ctx.pluginManager ?? this.ctx.get?.('pluginManager')
  }

  async syncAllSkills() {
    const skills = this.ledger.list().filter(entry => entry.type === 'skill')
    const activeIds = new Set(skills.map(entry => entry.id))
    for (const id of this.skillDisposers.keys()) {
      if (!activeIds.has(id)) this.unregisterSkill(id)
    }
    for (const entry of skills) {
      await this.syncSkill(entry).catch(() => undefined)
    }
  }

  async refreshRestartRequired() {
    let changed = false
    for (const entry of this.ledger.list().filter(candidate =>
      candidate.type === 'plugin'
      && (candidate.bundle?.application === 'restart-required'
        || candidate.latestHealth?.status === 'restart-required'))) {
      const item = localDisplayItem(entry)
      const hasBundleCheck = item.checks.some(check => check.type === 'plugin-bundle')
      const health = await this.runChecks(item, entry).catch(error => ({
        status: 'restart-required',
        detail: `重启后的只读检查尚未成功：${messageOf(error)}`,
      }))
      entry.latestHealth = health
      if (health.status === 'ready') {
        entry.bundle = {
          ...(entry.bundle ?? {}),
          application: 'applied',
          restartReason: null,
        }
        changed = true
      } else if (!hasBundleCheck && health.status !== 'restart-required') {
        entry.latestHealth = {
          status: 'restart-required',
          detail: health.detail,
        }
      } else if (hasBundleCheck && health.status !== 'restart-required') {
        changed = true
      }
    }
    if (changed) await this.ledger.write()
  }

  async syncSkill(entry) {
    const target = join(this.home, 'skills', entry.id)
    const raw = await readFile(join(target, 'SKILL.md'), 'utf8')
    const parsed = skillName(raw)
    if (parsed.name !== entry.id || !parsed.description) {
      throw new CapabilityError('invalid-skill', `技能 ${entry.id} 的 SKILL.md 名称或说明无效。`)
    }
    const registry = this.skillRegistry()
    if (registry === undefined || typeof registry.register !== 'function') return false
    this.skillDisposers.get(entry.id)?.()
    this.skillDisposers.delete(entry.id)
    const disposer = registry.register({
      name: entry.id,
      description: parsed.description,
      content: parsed.content + (entry.auxRuntime?.python ? '\n\n能力专用 Python 解释器：'+JSON.stringify(entry.auxRuntime.python) : '') + (entry.auxRuntime?.assets ? '\n\n能力资源绝对路径：'+JSON.stringify(entry.auxRuntime.assets) : ''),
      path: join(target, 'SKILL.md'),
      source: 'custom',
      provider: 'capability-center',
      resourceBase: { kind: 'directory', path: target.split(sep).join('/') },
      invocation: { modelInvocable: true, userInvocable: true },
    })
    this.skillDisposers.set(entry.id, disposer)
    return true
  }

  unregisterSkill(id) {
    const dispose = this.skillDisposers.get(id)
    this.skillDisposers.delete(id)
    dispose?.()
  }

  async resyncSkillsAfterRollback(journal) {
    const ids = new Set((journal?.intents ?? [])
      .filter(intent => intent.kind === 'skill' || intent.kind === 'skill-uninstall')
      .map(intent => intent.itemId)
      .filter(id => typeof id === 'string'))
    for (const id of ids) this.unregisterSkill(id)
    await this.syncAllSkills()
  }

  scheduleCatalogSync(delay = 15 * 60_000 + Math.floor(Math.random() * 60_000)) {
    clearTimeout(this.syncTimer)
    if (!this.acceptingWork || !this.catalogSync.source) return
    this.syncTimer = setTimeout(async () => {
      try { await this.updateSummary(this.catalogSync.source, { force: false, configure: false }) }
      catch { /* Retain last verified snapshot. */ }
      finally { if (this.acceptingWork) this.scheduleCatalogSync() }
    }, delay)
    this.syncTimer.unref?.()
  }

  async configureCatalog(serverUrl) {
    const before = this.catalogSync.source
    await this.catalogSync.select(serverUrl)
    if (before !== this.catalogSync.source) this.scheduleCatalogSync()
  }

  async catalog(serverUrl, {force=true}={}) {
    if (serverUrl === undefined || serverUrl === null || String(serverUrl).trim() === '') return undefined
    return await this.catalogSync.refresh(serverUrl,{force})
  }

  pluginInstallOptions(enabled) {
    // Do not resolve missing dependencies against any network registry.
    return {saveExact:true,registry:'http://127.0.0.1:9/',...(enabled===undefined?{}:{enabled})}
  }

  mergedCatalog(online) {
    const byId = new Map((online?.items ?? []).map(item => [item.id, item]))
    for (const entry of this.ledger.list()) {
      if (byId.has(entry.id)) continue
      byId.set(entry.id, localDisplayItem(entry))
    }
    return {
      schemaVersion: 2,
      name: online?.name ?? '本机安装账本',
      generatedFor: online?.generatedFor ?? 'dsh-v0.2.1-rc.2',
      items: [...byId.values()],
      offline: online === undefined,
    }
  }

  async inspect(serverUrl) {
    await this.configureCatalog(serverUrl)
    let online
    let onlineError
    try {
      online = await this.catalog(serverUrl)
    } catch (error) {
      onlineError = messageOf(error)
    }
    const snapshot=await this.catalogSync.snapshot(serverUrl)
    const catalog = this.mergedCatalog(online ?? snapshot.catalog)
    const summary=await this.updateSummary(serverUrl,{force:false,configure:false})
    const localStates = {}
    for (const item of catalog.items) {
      localStates[item.id] = await this.quickState(item, this.ledger.get(item.id))
    }
    return {
      serverUrl: serverUrl ? normalizeServerUrl(serverUrl) : null,
      online: online !== undefined,
      onlineError,
      updates: summary,
      recoveryRequired: this.recoveryRequired,
      recoveryMessages: this.recoveryMessages,
      legacyManagerEnabled: this.legacyManagerEnabled,
      refreshBridge: this.runtime.refreshBridge,
      core: {
        version: this.version,
        protocolVersion: 1,
        targetDsh: '0.2.1-rc.2',
      },
      catalog: {
        ...catalog,
        items: catalog.items.map(item => ({
          ...item,
          currentVersion: this.ledger.get(item.id)?.version ?? null,
          // The existing auto-continue catalog prompt is guidance, not a trial.
          trialAvailable: item.id !== AUTO_CONTINUE_ID,
          delisted: online !== undefined && !online.items.some(candidate => candidate.id === item.id),
          revoked: summary.revoked.some(candidate => candidate.id === item.id),
          artifact: item.artifact === undefined ? undefined : {
            path: item.artifact.path,
            sha256: item.artifact.sha256,
            bytes: item.artifact.bytes,
          },
        })),
      },
      localStates,
    }
  }

  async quickState(item, entry) {
    if (entry === undefined) return { installed: false, ready: false, detail: '未安装' }
    let filesPresent = true
    if (item.type === 'skill') {
      try { await readFile(join(this.home, 'skills', item.id, 'SKILL.md')) } catch { filesPresent = false }
    }
    if (item.type === 'python' && entry.runtimeRoot !== undefined) {
      try { await stat(entry.runtimeRoot) } catch { filesPresent = false }
    }
    const health = entry.latestHealth ?? { status: 'unknown', detail: '尚未检查' }
    return {
      installed: true,
      ready: filesPresent && health.status === 'ready',
      activation: health.status === 'restart-required' ? 'restart-required' : filesPresent ? health.status : 'failed',
      detail: filesPresent ? health.detail : '账本记录了安装，但受管文件缺失',
      currentVersion: entry.version,
      source: entry.source,
      legacy: entry.legacy === true,
      preexisting: entry.preexisting === true,
      adoptable: entry.legacy === true,
      dependencyOwners: entry.dependencyOwners ?? [],
      rootInstalled: entry.rootInstalled === true,
      latestHealth: health,
    }
  }

  startAction(serverUrl, itemId, action) {
    if (this.disposed || !this.acceptingWork) {
      throw new CapabilityError('disposed', '能力中心核心正在关闭或切换。')
    }
    if (this.recoveryRequired) {
      throw new CapabilityError('recovery-required', '存在无法证明已恢复的中断操作；请先处理恢复提示再继续。')
    }
    if (!['install', 'update', 'uninstall', 'diagnose'].includes(action)) {
      throw new CapabilityError('invalid-action', '未知操作。')
    }
    if (typeof itemId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(itemId)) {
      throw new CapabilityError('unknown-item', '条目 ID 无效。')
    }
    const operation = {
      id: randomUUID(),
      action,
      itemId,
      status: 'queued',
      phase: '排队',
      progress: 0,
      logs: [],
      activation: undefined,
      error: undefined,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    this.operations.set(operation.id, operation)
    while (this.operations.size > 50) this.operations.delete(this.operations.keys().next().value)
    const task = this.queue.then(async () => {
      if (this.disposed) {
        this.transition(operation, 'failed', '已停止', { error: '能力中心核心正在关闭。' })
        return
      }
      this.transition(operation, 'running', '读取目录', { progress: 0.03 })
      try {
        const outcome = await this.execute(serverUrl, itemId, action, operation)
        this.transition(operation, outcome.status, outcome.phase, {
          progress: 1,
          activation: outcome.activation,
          output: outcome.output,
        })
        if (outcome.log) this.log(operation, outcome.log)
      } catch (error) {
        const code = error?.code ?? 'operation-failed'
        this.transition(operation, 'failed', '失败', {
          progress: 1,
          activation: 'failed',
          error: messageOf(error),
        })
        this.log(operation, `失败 [${code}] ${messageOf(error)}`)
      }
    })
    operation.done = task
    this.queue = task.catch(() => undefined)
    return this.publicOperation(operation)
  }

  hasPendingActions() {
    return [...this.operations.values()].some(operation => !TERMINAL.has(operation.status))
  }

  async execute(serverUrl, itemId, action, operation) {
    let online
    let onlineError
    try {
      online = await this.catalog(serverUrl)
    } catch (error) {
      onlineError = error
    }
    const state = this.ledger.get(itemId)
    const localItem = state === undefined ? undefined : localDisplayItem(state)
    const onlineItem = online?.items.find(candidate => candidate.id === itemId)
    const item = ['uninstall', 'diagnose'].includes(action) ? localItem : onlineItem
    if (item === undefined) throw new CapabilityError('unknown-item', '目录与本机账本中都没有该能力。')
    if (item.hidden === true || localItem?.hidden === true) {
      throw new CapabilityError(
        'component-only',
        '该条目是 Office 增强的隐藏组件，请通过 office-enhancement 组合统一安装、检查或卸载。',
      )
    }
    if (action === 'uninstall') return await this.uninstall(item, operation)
    if (action === 'diagnose') return await this.diagnose(item, operation)
    if (onlineError !== undefined) throw onlineError
    if (online === undefined) throw new CapabilityError('catalog-unavailable', '安装或更新需要连接内网目录。')
    if (action === 'update') return await this.update(online, item, operation)
    return await this.install(online, item, operation)
  }

  async preparePlan(catalog, rootId, operation) {
    validateGraph(catalog)
    const plan = planCapabilities(catalog, rootId)
    const artifacts = new Map()
    const reuse = new Map()
    const externalPypdf = new Map()
    const needsPython = plan.order.some(item => item.type === 'python'
      || item.compatibility?.python !== undefined || item.runtime?.python !== undefined)
    this.transition(operation, 'running', '检查安装环境', { progress: 0.08 })
    const pythonRuntime = needsPython ? await this.workspaceDependencies() : undefined
    for (const [index, item] of plan.order.entries()) {
      const incompatibility = compatibilityError(item, { pythonVersion: pythonRuntime?.version })
      if (incompatibility !== undefined) {
        throw new CapabilityError('incompatible-capability', `${item.name} 不兼容：${incompatibility}`)
      }
      if (item.type !== 'composite') {
        const existing = this.ledger.get(item.id)
        if (existing?.version === item.version) {
          if (item.type === 'skill' || item.type === 'python') {
            await verifyOwnedFiles(existing.runtimeRoot, existing.ownedFiles)
          }
          const health = await this.runChecks(item, existing)
          if (!['ready', 'restart-required'].includes(health.status)) {
            throw new CapabilityError(
              'reuse-check-failed',
              `${item.name} 已有同版本受管安装，但复用前检查失败：${health.detail}`,
            )
          }
          reuse.set(item.id, health)
          continue
        }
        if (item.id === PYPDF_ID && existing === undefined) {
          const probe = await this.pypdfMetadata(pythonRuntime)
          if (probe.present || probe.unknownModule) {
            if (probe.count !== 1 || probe.versions?.[0] !== item.version
              || probe.originVerified !== true) {
              throw new CapabilityError(
                'pypdf-conflict',
                `本机已有不兼容或无法唯一确认的 pypdf（${probe.versions.join(', ') || 'unknown'}），拒绝覆盖；请先由原管理者处理。`,
              )
            }
            externalPypdf.set(item.id, probe)
          }
        }
        this.transition(operation, 'running', `下载并校验 ${item.name}`, {
          progress: 0.12 + (index / plan.order.length) * 0.36,
        })
        artifacts.set(item.id, await downloadArtifact(item, this.dataRoot, this.runtime.http))
      }
    }
    return {
      ...plan,
      artifacts,
      reuse,
      externalPypdf,
      borrowed: new Map(),
      pythonRuntime,
    }
  }

  validatePinnedDependents(plan) {
    const plannedIds = new Set(plan.order.map(item => item.id))
    for (const item of plan.order) {
      const existing = this.ledger.get(item.id)
      if (existing === undefined || existing.version === item.version) continue
      for (const owner of this.ledger.list()) {
        if (plannedIds.has(owner.id)) continue
        const conflicting = (owner.manifest.dependencies ?? []).find(dependency =>
          dependency.id === item.id && dependency.version !== item.version)
        if (conflicting !== undefined) {
          throw new CapabilityError(
            'dependency-conflict',
            `${item.name} 从 ${existing.version} 更新到 ${item.version} 会破坏仍固定 ${item.id}@${conflicting.version} 的 ${owner.manifest.name}。请先一并升级使用方。`,
          )
        }
      }
    }
  }

  async install(catalog, rootItem, operation) {
    const state = this.ledger.get(rootItem.id)
    if (state?.version === rootItem.version && this.versionAtLeast(state.version, rootItem.version)) {
      return await this.diagnose(rootItem, operation)
    }
    const plan = await this.preparePlan(catalog, rootItem.id, operation)
    this.validatePinnedDependents(plan)
    await this.preflightOwnership(plan)
    return await this.applyPlan(plan, operation, { action: 'install', rootId: rootItem.id })
  }

  async update(catalog, item, operation) {
    const entry = this.ledger.get(item.id)
    if (entry === undefined) {
      throw new CapabilityError('not-installed', '该能力尚未安装。')
    }
    const comparison = compareVersions(item.version, entry.version)
    if (comparison < 0) {
      throw new CapabilityError('DOWNGRADE_DETECTED', `目录版本 ${item.version} 低于已安装版本 ${entry.version}，不执行降级。`)
    }
    if (comparison === 0) {
      throw new CapabilityError('VERSION_UNCHANGED', `已安装 ${entry.version}，没有更高版本。`)
    }
    const plan = await this.preparePlan(catalog, item.id, operation)
    this.validatePinnedDependents(plan)
    await this.preflightOwnership(plan)
    return await this.applyPlan(plan, operation, { action: 'update', rootId: item.id })
  }

  versionAtLeast(left, right) {
    return compareVersions(left, right) >= 0
  }

  async preflightOwnership(plan) {
    for (const item of plan.order) {
      const entry = this.ledger.get(item.id)
      if (entry !== undefined) {
        if(entry.type!==item.type)throw new CapabilityError('implementation-changed', '能力实现类型已变更，请先卸载旧版本再安装新版本。')
        if ((entry.preexisting === true || entry.borrowed === true || entry.legacy === true)
          && entry.version !== item.version) {
          throw new CapabilityError(
            'preexisting-version-conflict',
            `${item.name} 的现有${entry.borrowed === true ? '借用' : '预先存在'}版本为 ${entry.version}，目标固定为 ${item.version}；能力中心不会覆盖该安装。`,
          )
        }
        continue
      }
      if (plan.reuse.has(item.id)) continue
      if (item.type === 'skill' && item.id === OFFICE_SKILL_ID) {
        try {
          const target = join(this.home, 'skills', item.id)
          await stat(target)
          const artifact = plan.artifacts.get(item.id)
          if (artifact === undefined) {
            throw new CapabilityError('artifact-missing', `技能 ${item.id} 缺少用于一致性校验的制品。`)
          }
          const expected = skillArchiveRecords(item, await readFile(artifact))
          const actual = await collectDirectoryFiles(target)
          if (!exactRecordsMatch(expected, actual)) {
            throw new CapabilityError(
              'preexisting-skill-conflict',
              `技能目录 ${item.id} 已存在，但文件内容与固定制品不一致；拒绝覆盖或借用。`,
            )
          }
          plan.borrowed.set(item.id, {
            type: 'skill',
            runtimeRoot: target,
            ownedFiles: expected,
            source: 'preexisting-skill',
          })
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      }
      if (item.type === 'plugin') {
        const bundles = await this.pluginManager()?.listBundles?.().catch(() => [])
        if (bundles?.some(bundle => bundle.name === item.install.packageName && bundle.installed)) {
          throw new CapabilityError('preexisting-capability', `插件 ${item.install.packageName} 已存在但没有能力中心所有权记录，拒绝重新安装。`)
        }
      }
      if (item.type === 'python') {
        const runtime = await this.workspaceDependencies().catch(() => undefined)
        if (runtime !== undefined) {
          if (item.id === PYPDF_ID && plan.externalPypdf.has(item.id)) {
            const artifact = plan.artifacts.get(item.id)
            if (artifact === undefined) {
              throw new CapabilityError('artifact-missing', 'pypdf 借用校验缺少固定 wheel。')
            }
            const expected = wheelRecords(item, await readFile(artifact))
            let actual
            try {
              actual = await this.pypdfFileRecords(plan.externalPypdf.get(item.id), expected)
            } catch (error) {
              throw new CapabilityError(
                'pypdf-conflict',
                `本机 pypdf 文件与可信 wheel RECORD 不一致或无法读取：${messageOf(error)}`,
              )
            }
            if (!exactRecordsMatch(expected, actual)) {
              throw new CapabilityError(
                'pypdf-conflict',
                '本机 pypdf 元数据版本相同，但文件或 RECORD 与可信 wheel 不一致；拒绝借用。',
              )
            }
            plan.borrowed.set(item.id, {
              type: 'python',
              runtimeRoot: plan.externalPypdf.get(item.id).root,
              pythonPackages: runtime.pythonPackages,
              ownedFiles: expected,
              source: 'preexisting-python',
            })
            continue
          }
          if (item.id === PYPDF_ID) {
            const probe = await this.pypdfMetadata(runtime).catch(() => undefined)
            if (probe?.present === true || probe?.unknownModule === true) {
              throw new CapabilityError(
                'pypdf-conflict',
                '本机 pypdf 状态无法通过固定预检，拒绝覆盖。',
              )
            }
          } else {
            const probe = await this.pythonImport(runtime, item.install.module).catch(() => undefined)
            if (probe?.version !== undefined) {
              throw new CapabilityError('preexisting-capability', `Python 模块 ${item.install.module} 已由其他来源提供，拒绝覆盖。`)
            }
          }
        }
      }
    }
  }

  async pypdfMetadata(runtime) {
    const source = [
      'import importlib.metadata as metadata',
      'import importlib.util as util',
      'import json',
      'matches = []',
      'for distribution in metadata.distributions():',
      '    name = (distribution.metadata.get("Name") or "").strip().lower()',
      '    if name == "pypdf":',
      '        matches.append({',
      '            "version": distribution.version,',
      '            "root": str(distribution.locate_file(""))',
      '        })',
      'try:',
      '    spec = util.find_spec("pypdf")',
      'except (ImportError, ValueError):',
      '    spec = None',
      'origin = getattr(spec, "origin", None)',
      'origin_verified = False',
      'if len(matches) == 1 and isinstance(origin, str):',
      '    expected = (metadata.distribution("pypdf").locate_file("pypdf/__init__.py"))',
      '    try:',
      '        origin_verified = __import__("pathlib").Path(origin).resolve() == __import__("pathlib").Path(expected).resolve()',
      '    except OSError:',
      '        origin_verified = False',
      'result = {',
      '    "present": len(matches) > 0,',
      '    "unknownModule": bool(spec is not None and not matches),',
      '    "count": len(matches),',
      '    "versions": sorted({value["version"] for value in matches}),',
      '    "root": matches[0]["root"] if len(matches) == 1 else None,',
      '    "origin": origin,',
      '    "originVerified": origin_verified',
      '}',
      'print(json.dumps(result, ensure_ascii=False))',
    ].join('\n')
    const probe = await runFile(runtime.python, ['-I', '-c', source], {
      timeout: 20_000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    return JSON.parse(probe.stdout.trim())
  }

  async pypdfFileRecords(probe, expected) {
    const runtime = await this.workspaceDependencies()
    const encoded = Buffer.from(JSON.stringify(expected.map(record => record.path)), 'utf8')
      .toString('base64')
    const source = [
      'import base64, hashlib, importlib.metadata as metadata, json, os, sys',
      'from pathlib import Path',
      'paths = json.loads(base64.b64decode(sys.argv[1]).decode("utf-8"))',
      'distribution = metadata.distribution("pypdf")',
      'base = Path(distribution.locate_file("")).resolve()',
      'records = []',
      'for relative in paths:',
      '    current = Path(distribution.locate_file(relative))',
      '    resolved = current.resolve()',
      '    if not resolved.is_relative_to(base):',
      '        raise RuntimeError(f"path escapes distribution root: {relative}")',
      '    if not current.is_file():',
      '        raise RuntimeError(f"expected package file is missing: {relative}")',
      '    content = current.read_bytes()',
      '    records.append({',
      '        "path": relative,',
      '        "bytes": len(content),',
      '        "sha256": hashlib.sha256(content).hexdigest()',
      '    })',
      'print(json.dumps(records, ensure_ascii=False))',
    ].join('\n')
    if (typeof probe.root !== 'string') {
      throw new CapabilityError('pypdf-conflict', 'pypdf 发行版根目录无法唯一确认。')
    }
    const result = await runFile(runtime.python, [
      '-I',
      '-c',
      source,
      encoded,
    ], {
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    })
    return JSON.parse(result.stdout.trim())
  }

  async applyPlan(plan, operation, { action, rootId }) {
    const before = this.ledger.snapshot()
    const journal = await this.ledger.begin({
      operationId: operation.id,
      action,
      itemId: rootId,
      beforeVersion: this.ledger.get(rootId)?.version,
      targetVersion: plan.root.version,
    })
    try {
      for (const [index, item] of plan.order.entries()) {
        this.transition(operation, 'running', `安装 ${item.name}`, {
          progress: 0.5 + (index / Math.max(1, plan.order.length)) * 0.31,
        })
        const existing = this.ledger.get(item.id)
        if (item.type === 'composite') {
          await this.recordComposite(item, plan, rootId)
          continue
        }
        if (existing === undefined && plan.borrowed.has(item.id)) {
          this.ledger.value.entries[item.id] = this.borrowedEntry(
            item,
            plan.borrowed.get(item.id),
            operation,
          )
          await this.addOwners(item.id, plan.owners[item.id] ?? [], item.id === rootId)
          await this.fault('child-installed', { itemId: item.id, version: item.version })
          continue
        }
        if (existing?.version === item.version) {
          await this.addOwners(item.id, plan.owners[item.id] ?? [], item.id === rootId)
          continue
        }
        if (existing !== undefined && compareVersions(item.version, existing.version) < 0) {
          throw new CapabilityError('DOWNGRADE_DETECTED', `${item.name} 不允许从 ${existing.version} 降级到 ${item.version}。`)
        }
        const auxRuntime=await prepareRuntime({root:this.dataRoot,item,operationId:operation.id,http:this.runtime.http,basePython:item.runtime?.python?plan.pythonRuntime:undefined,beforeMutation:intent=>this.ledger.appendIntent(operation.id,intent)})
        if (existing !== undefined && item.type === 'plugin') {
          const manager = this.pluginManager()
          if (typeof existing.artifacts?.[0] !== 'string') {
            throw new CapabilityError('previous-artifact-missing', '旧版插件缓存缺失，拒绝在无法回滚时更新。')
          }
          await this.ledger.appendIntent(operation.id, {
            kind: 'plugin-remove',
            itemId: item.id,
            packageName: existing.manifest.install.packageName,
            beforeVersion: existing.version,
            targetVersion: item.version,
            beforeArchive: existing.artifacts[0],
          })
          await this.ledger.addStep(operation.id, { step: 'plugin-remove-before-update', itemId: item.id })
          const removed = await manager.removeBundle(existing.manifest.install.packageName)
          if (!['applied', 'restart-required'].includes(removed?.application)) {
            throw new CapabilityError('plugin-remove-failed', `插件旧版本移除失败：${removed?.error?.diagnostic ?? removed?.application}`)
          }
          await this.ledger.addStep(operation.id, { step: 'plugin-removed-old', itemId: item.id, result: removed?.application })
          await this.fault('plugin-removed', { itemId: item.id, version: item.version })
        }
        const installed = await this.installOne(item, plan.artifacts.get(item.id), operation, journal)
        this.ledger.value.entries[item.id] = {...installed.entry,...(auxRuntime?{auxRuntime}: {})}
        await this.addOwners(item.id, plan.owners[item.id] ?? [], item.id === rootId)
        await this.fault('child-installed', { itemId: item.id, version: item.version })
      }
      this.transition(operation, 'running', '自动检查', { progress: 0.84 })
      const failures = []
      let restartRequired = false
      for (const item of plan.order) {
        const health = await this.runChecks(item, this.ledger.get(item.id))
        this.ledger.get(item.id).latestHealth = health
        if (health.status === 'restart-required') restartRequired = true
        if (!['ready', 'restart-required'].includes(health.status)) {
          failures.push(`${item.name}: ${health.detail}`)
        }
      }
      if (failures.length > 0) {
        throw new CapabilityError('postinstall-check-failed', `安装后检查失败：${failures.join('；')}`)
      }
      if (this.ledger.get(rootId)?.type === 'composite' && !restartRequired) {
        this.ledger.get(rootId).latestHealth = { status: 'ready', detail: '组合依赖已安装并通过检查' }
      }
      for (const entry of this.ledger.list()) entry.lastOperation = `${action}:${operation.id}`
      await this.ledger.commit(operation.id)
      await this.syncAllSkills()
      await rm(join(this.dataRoot, 'rollback', operation.id), { recursive: true, force: true })
      return {
        status: restartRequired ? 'restart-required' : 'ready',
        phase: restartRequired ? '已安装，等待重启' : '安装完成',
        activation: restartRequired ? 'restart-required' : 'applied',
        output: { installed: plan.order.map(item => item.id), action },
        log: restartRequired
          ? '制品与账本已提交；部分插件需要重启 DSH 后才会注册运行态。'
          : '全部制品已校验，安装账本已原子提交，自动检查通过。',
      }
    } catch (error) {
      if (error?.simulatedCrash === true) {
        this.recoveryRequired = true
        this.recoveryMessages.push(`${operation.id}: 模拟进程在变更中途退出`)
        throw error
      }
      try {
        await this.rollbackJournalIntents(await this.latestJournal(operation.id))
        this.ledger.restore(before)
        await this.ledger.write()
        await this.resyncSkillsAfterRollback(await this.latestJournal(operation.id))
        await this.ledger.updateJournal(operation.id, {
          phase: 'rolled-back',
          failure: messageOf(error),
        })
        await this.ledger.close(operation.id)
        await rm(join(this.dataRoot, 'rollback', operation.id), { recursive: true, force: true })
      } catch (rollbackError) {
        this.recoveryRequired = true
        const message = `变更失败，且回滚无法完整证明：${messageOf(rollbackError)}`
        this.recoveryMessages.push(`${operation.id}: ${message}`)
        await this.ledger.updateJournal(operation.id, {
          phase: 'recovery-required',
          recoveryRequired: true,
          failure: messageOf(error),
          rollbackFailure: messageOf(rollbackError),
        }).catch(() => undefined)
        throw new CapabilityError('rollback-incomplete', `${messageOf(error)}；${message}`)
      }
      throw error
    }
  }

  async recordComposite(item, plan, rootId) {
    const existing = this.ledger.get(item.id)
    this.ledger.value.entries[item.id] = {
      id: item.id,
      type: 'composite',
      version: item.version,
      source: 'intranet',
      manifest: serializableItem(item),
      ownedFiles: [],
      runtimeRoot: null,
      dependencyOwners: existing?.dependencyOwners ?? [],
      rootInstalled: item.id === rootId || existing?.rootInstalled === true,
      artifacts: [],
      latestHealth: { status: 'unknown', detail: '等待依赖检查' },
      lastOperation: 'installing',
      dependencies: {...plan.owners},
    }
  }

  borrowedEntry(item, borrowed, operation) {
    return {
      id: item.id,
      type: item.type,
      version: item.version,
      source: borrowed.source,
      manifest: serializableItem(item),
      ownedFiles: borrowed.ownedFiles,
      runtimeRoot: borrowed.runtimeRoot,
      pythonPackages: borrowed.pythonPackages,
      artifactRoot: null,
      artifacts: [],
      dependencyOwners: [],
      rootInstalled: false,
      preexisting: true,
      borrowed: true,
      latestHealth: { status: 'unknown', detail: '已按固定哈希借用，等待检查' },
      lastOperation: `borrow:${operation.id}`,
    }
  }

  async addOwners(itemId, ownerIds, rootInstalled) {
    const entry = this.ledger.get(itemId)
    if (entry === undefined) return
    entry.dependencyOwners = [...new Set([...(entry.dependencyOwners ?? []), ...ownerIds])].sort()
    if (rootInstalled) entry.rootInstalled = true
  }

  async installOne(item, artifact, operation, journal) {
    const bytes = await readFile(artifact)
    if (item.type === 'skill') {
      const installed = await installSkill({
        item,
        bytes,
        dataRoot: this.dataRoot,
        dshHome: this.home,
        operationId: operation.id,
        beforeMutation: async intent => {
          await this.ledger.appendIntent(operation.id, { ...intent, itemId: item.id })
        },
      })
      await this.ledger.addStep(operation.id, { step: 'skill-installed', itemId: item.id })
      await this.syncSkill({ id: item.id }).catch(() => undefined)
      return {
        entry: {
          id: item.id,
          type: item.type,
          version: item.version,
          source: 'intranet',
          manifest: serializableItem(item),
          ownedFiles: installed.ownedFiles,
          runtimeRoot: installed.runtimeRoot,
          artifactRoot: dirname(artifact),
          artifacts: [artifact],
          dependencyOwners: [],
          rootInstalled: false,
          latestHealth: { status: 'unknown', detail: '等待检查' },
          lastOperation: `install:${operation.id}`,
        },
      }
    }
    if (item.type === 'python') {
      const runtime = await this.workspaceDependencies()
      const installed = await installPython({
        item,
        bytes,
        dataRoot: this.dataRoot,
        pythonPackages: runtime.pythonPackages,
        operationId: operation.id,
        beforeMutation: async intent => {
          await this.ledger.appendIntent(operation.id, { ...intent, itemId: item.id })
        },
      })
      await this.ledger.addStep(operation.id, { step: 'python-installed', itemId: item.id })
      return {
        entry: {
          id: item.id,
          type: item.type,
          version: item.version,
          source: 'intranet',
          manifest: serializableItem(item),
          ownedFiles: installed.ownedFiles,
          runtimeRoot: installed.runtimeRoot,
          pythonPackages: installed.pythonPackages,
          pth: installed.pth,
          artifactRoot: dirname(artifact),
          artifacts: [artifact],
          dependencyOwners: [],
          rootInstalled: false,
          latestHealth: { status: 'unknown', detail: '等待检查' },
          lastOperation: `install:${operation.id}`,
        },
      }
    }
    if (item.type === 'plugin') {
      const manager = this.pluginManager()
      if (typeof manager?.installBundle !== 'function') {
        throw new CapabilityError('dsh-capability-missing', 'DSH 未提供 pluginManager.installBundle。')
      }
      const old = this.ledger.get(item.id)
      await this.ledger.appendIntent(operation.id, {
        kind: 'plugin-install',
        itemId: item.id,
        packageName: item.install.packageName,
        targetVersion: item.version,
        beforeVersion: old?.version ?? null,
      })
      const result = await manager.installBundle(artifact, this.pluginInstallOptions(true))
      if (!['applied', 'restart-required', 'overridden'].includes(result?.application)) {
        throw new CapabilityError('plugin-install-failed',
          `插件安装失败：${result?.error?.diagnostic ?? result?.application ?? '无结果'}`)
      }
      await this.ledger.addStep(operation.id, { step: 'plugin-installed-new', itemId: item.id, result: result.application })
      return {
        entry: {
          id: item.id,
          type: item.type,
          version: item.version,
          source: 'intranet',
          manifest: serializableItem(item),
          ownedFiles: [{
            path: basename(artifact),
            bytes: bytes.byteLength,
            sha256: item.artifact.sha256,
          }],
          runtimeRoot: dirname(artifact),
          artifacts: [artifact],
          dependencyOwners: [],
          rootInstalled: false,
          latestHealth: {
            status: result.application === 'restart-required' ? 'restart-required' : 'unknown',
            detail: result.application === 'restart-required' ? '插件已保存，等待重启' : '等待自动检查',
          },
          lastOperation: `install:${operation.id}`,
          bundle: { application: result.application, restartReason: result.restartReason ?? null },
        },
      }
    }
    throw new CapabilityError('unsupported-type', `不支持的能力类型：${item.type}`)
  }

  async runChecks(item, entry) {
    if (entry === undefined) return { status: 'failed', detail: '账本中没有该能力' }
    if(entry.manifest?.runtime){
      try{await verifyRuntime(this.dataRoot,{...item,runtime:entry.manifest.runtime},entry.auxRuntime)}catch(error){return {status:'failed',detail:messageOf(error)}}
    }
    if (!Array.isArray(item.checks) || item.checks.length === 0) {
      return { status: 'failed', detail: '本机账本缺少可执行检查声明，已保留安装文件。' }
    }
    if (item.id === PYPDF_ID) {
      return await this.checkPypdf(item, entry)
    }
    for (const check of item.checks) {
      if(check.type==='dependencies-ready'){
        for(const dep of item.dependencies??[]){const child=this.ledger.get(dep.id);if(!child||child.version!==dep.version||!['ready','restart-required'].includes(child.latestHealth?.status))return {status:'failed',detail:'组合依赖未就绪：'+dep.id};if(child.latestHealth.status==='restart-required')return {status:'restart-required',detail:'组合依赖等待重启：'+dep.id}}
        continue
      }
      if (check.type === 'office-smoke') {
        const health = await this.checkOfficeSmoke(item)
        if (health.status !== 'ready') return health
        continue
      }
      if (!['plugin-bundle', 'skill-discovery', 'named-tool-readonly-call', 'python-import', 'python-function']
        .includes(check?.type)) {
        return { status: 'failed', detail: '本机账本包含不受支持的检查类型。' }
      }
      if (check.type === 'plugin-bundle') {
        const health = await this.checkPluginBundle(item, entry)
        if (health.status !== 'ready') return health
        continue
      }
      if (check.type === 'skill-discovery') {
        try {
          const checkedId = check.name ?? item.id
          const checkedEntry = this.ledger.get(checkedId) ?? entry
          await this.syncSkill({ ...checkedEntry, id: checkedId })
          const definition = await this.skillRegistry()?.get?.(checkedId, { signal: AbortSignal.timeout(3_000) })
          if (definition?.provider !== 'capability-center') {
            return { status: 'failed', detail: `技能 ${checkedId} 文件存在，但 DSH 尚未发现能力中心注册的版本` }
          }
        } catch (error) {
          return { status: 'failed', detail: `技能发现失败：${messageOf(error)}` }
        }
      }
      if (check.type === 'named-tool-readonly-call') {
        if (typeof this.ctx.tools?.execute !== 'function') {
          return entry.bundle?.application === 'restart-required'
            ? { status: 'restart-required', detail: '插件已保存，DSH 尚未提供工具执行接口' }
            : { status: 'failed', detail: 'DSH 未提供工具执行接口' }
        }
        try {
          const result = await this.executeTool(
            check.tool,
            {},
            AbortSignal.timeout(20_000),
            'check',
          )
          if (result === undefined || result === null || result.isError !== false
            || !(Object.hasOwn(result, 'value')
              || (Array.isArray(result.content) && result.content.length > 0))) {
            if (entry.bundle?.application === 'restart-required') {
              return { status: 'restart-required', detail: `插件已保存，等待重启注册工具 ${check.tool}` }
            }
            return { status: 'failed', detail: `只读工具 ${check.tool} 未返回可证明成功的结果` }
          }
          if (entry.bundle?.application === 'restart-required') {
            entry.bundle = { ...entry.bundle, application: 'applied', restartReason: null }
          }
        } catch (error) {
          if (entry.bundle?.application === 'restart-required') {
            return { status: 'restart-required', detail: `插件已保存，工具 ${check.tool} 尚未在重启后注册` }
          }
          return { status: 'failed', detail: `只读工具 ${check.tool} 执行失败：${messageOf(error)}` }
        }
      }
      if (check.type === 'python-import' || check.type === 'python-function') {
        const runtime = entry.auxRuntime?.python?{python:entry.auxRuntime.python}:await this.workspaceDependencies()
        const importResult = await this.pythonImport(runtime, check.module ?? item.install?.module)
        if (check.type === 'python-function') {
          const output = await this.pythonKnownSafe(runtime, check.name)
          if (!output.includes('能力') || !output.includes('状态')
            || !output.includes('插件') || !output.includes('技能')) {
            return { status: 'failed', detail: '已允许的 Python 函数检查没有返回预期表格' }
          }
        }
        if (check.version !== undefined && importResult.version !== check.version) {
          return { status: 'failed', detail: `Python 版本为 ${importResult.version}，期望 ${check.version}` }
        }
      }
    }
    return { status: 'ready', detail: '自动检查通过', checkedAt: new Date().toISOString() }
  }

  async checkPluginBundle(item, entry) {
    const packageName = item.install?.packageName
    if (typeof packageName !== 'string' || packageName === '') {
      return { status: 'failed', detail: '插件检查缺少固定 packageName。' }
    }
    const manager = this.pluginManager()
    if (typeof manager?.listBundles !== 'function') {
      return { status: 'failed', detail: 'DSH 未提供 pluginManager.listBundles，无法检查插件运行态。' }
    }

    let bundles
    try {
      bundles = await manager.listBundles()
    } catch (error) {
      return { status: 'failed', detail: `读取插件清单失败：${messageOf(error)}` }
    }
    const bundle = Array.isArray(bundles)
      ? bundles.find(candidate => candidate?.name === packageName)
      : undefined
    if (bundle === undefined) {
      return { status: 'missing', detail: `DSH 插件清单中不存在 ${packageName}。` }
    }
    if (bundle.error !== undefined) {
      const code = typeof bundle.error?.code === 'string' ? bundle.error.code : 'unknown'
      return {
        status: 'failed',
        detail: `插件 ${packageName} 清单状态失败：${bundle.error.diagnostic ?? code}`,
      }
    }
    if (bundle.installed !== true || bundle.availability === 'missing') {
      return { status: 'missing', detail: `插件 ${packageName} 未安装或文件缺失。` }
    }
    if (bundle.version !== item.version) {
      return {
        status: 'failed',
        detail: `插件版本为 ${bundle.version ?? '未知'}，期望 ${item.version}。`,
      }
    }
    if (bundle.enabled !== true) {
      return { status: 'disabled', detail: `插件 ${packageName} 已在 DSH 中停用。` }
    }
    const rows = Array.isArray(bundle.rows) ? bundle.rows : []
    if (rows.length === 0) {
      return { status: 'failed', detail: `插件 ${packageName} 没有可检查的运行行。` }
    }
    if (typeof manager.listPlugins !== 'function') {
      return { status: 'failed', detail: 'DSH 未提供 pluginManager.listPlugins，无法确认插件已激活。' }
    }

    let plugins
    try {
      plugins = await manager.listPlugins()
    } catch (error) {
      return { status: 'failed', detail: `读取插件运行态失败：${messageOf(error)}` }
    }
    if (!Array.isArray(plugins)) {
      return { status: 'failed', detail: 'DSH pluginManager.listPlugins 未返回运行态列表。' }
    }
    for (const row of rows) {
      if (typeof row?.entryId !== 'string' || row.entryId === '') {
        return {
          status: 'restart-required',
          detail: `插件 ${packageName} 已保存，等待 Loader 启动运行行。`,
        }
      }
      const plugin = plugins.find(candidate => candidate?.entryId === row.entryId)
      if (plugin === undefined) {
        return {
          status: 'restart-required',
          detail: `插件 ${packageName} 的运行行尚未进入 Loader。`,
        }
      }
      if (plugin.enabled !== true) {
        return { status: 'disabled', detail: `插件 ${packageName} 的运行行已停用。` }
      }
      if (plugin.fiberPhase === 'failed') {
        return { status: 'failed', detail: `插件 ${packageName} 的运行行启动失败。` }
      }
      if (plugin.fiberPhase !== 'active') {
        return {
          status: 'restart-required',
          detail: `插件 ${packageName} 的运行态为 ${String(plugin.fiberPhase)}，等待激活。`,
        }
      }
    }
    if (entry.bundle?.application === 'restart-required') {
      entry.bundle = { ...entry.bundle, application: 'applied', restartReason: null }
    }
    return {
      status: 'ready',
      detail: `插件 ${packageName}@${item.version} 已安装并激活。`,
      checkedAt: new Date().toISOString(),
    }
  }

  async checkPypdf(item, entry) {
    try {
      await verifyOwnedFiles(entry.runtimeRoot, entry.ownedFiles)
      const runtime = await this.workspaceDependencies()
      const probe = await this.pypdfMetadata(runtime)
      if (probe.count !== 1 || probe.versions?.[0] !== item.version
        || probe.originVerified !== true) {
        return {
          status: 'failed',
          detail: `pypdf 元数据必须唯一为 ${item.version}，当前为 ${probe.versions.join(', ') || 'unknown'}`,
        }
      }
      return {
        status: 'ready',
        detail: `pypdf ${item.version} 文件、版本与可信 RECORD 校验通过`,
        checkedAt: new Date().toISOString(),
      }
    } catch (error) {
      return { status: 'failed', detail: `pypdf 完整性检查失败：${messageOf(error)}` }
    }
  }

  async checkOfficeSmoke(item) {
    try {
      const pypdf = this.ledger.get(PYPDF_ID)
      if (pypdf === undefined) {
        return { status: 'failed', detail: 'pypdf 组件尚未登记。' }
      }
      const pypdfHealth = await this.checkPypdf(pypdf.manifest, pypdf)
      if (pypdfHealth.status !== 'ready') return pypdfHealth
      const skill = this.ledger.get(OFFICE_SKILL_ID)
      if (skill === undefined) {
        return { status: 'failed', detail: 'Office 技能组件尚未安装。' }
      }
      const smokePath = join(skill.runtimeRoot, ...OFFICE_SMOKE_PATH.split('/'))
      const toolsPath = join(skill.runtimeRoot, ...OFFICE_TOOLS_PATH.split('/'))
      const [smoke, tools] = await Promise.all([readFile(smokePath), readFile(toolsPath)])
      if (sha256(smoke) !== OFFICE_SMOKE_SHA256 || sha256(tools) !== OFFICE_TOOLS_SHA256) {
        return {
          status: 'failed',
          detail: 'Office 固定自动检查或工具脚本的完整性校验失败。',
        }
      }
      const runtime = await this.workspaceDependencies()
      const result = await runFile(runtime.python, [
        '-I',
        '-B',
        '-c',
        'import runpy, sys; sys.path.insert(0, sys.argv[1]); runpy.run_path(sys.argv[2], run_name="__main__")',
        dirname(smokePath),
        smokePath,
      ], {
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        cwd: skill.runtimeRoot,
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
        },
      })
      const output = JSON.parse(result.stdout.trim())
      const versions = output?.packages
      const operations = output?.operations
      if (versions?.['python-docx'] !== '1.2.0'
        || versions?.['openpyxl'] !== '3.1.5'
        || versions?.['python-pptx'] !== '1.0.2'
        || versions?.['pandas'] !== '3.0.1'
        || versions?.pypdf !== '7.1.0'
        || operations?.pdfPages !== 2
        || !Number.isSafeInteger(operations?.xlsxDiffRows)
        || operations.xlsxDiffRows < 1
        || operations?.pptxSlides !== 1) {
        return { status: 'failed', detail: 'Office 自动检查返回的版本或操作结果不符合固定期望。' }
      }
      return {
        status: 'ready',
        detail: `${item.name} 的固定 Office 自动检查通过`,
        checkedAt: new Date().toISOString(),
      }
    } catch (error) {
      return { status: 'failed', detail: `Office 固定自动检查失败：${messageOf(error)}` }
    }
  }

  async workspaceDependencies() {
    if (typeof this.ctx.tools?.execute !== 'function') {
      throw new CapabilityError('python-runtime-missing', 'DSH 未提供 tools.execute。')
    }
    const result = await this.executeTool(
      'load_workspace_dependencies',
      {},
      AbortSignal.timeout(30_000),
      'python',
    )
    if (result?.isError === true || typeof result?.value?.python !== 'string'
      || typeof result?.value?.pythonPackages !== 'string') {
      throw new CapabilityError('python-runtime-missing', 'DSH 没有返回 Python 解释器与 pythonPackages。')
    }
    let pythonVersion
    try {
      const probe = await runFile(result.value.python, ['-s', '-c',
        'import sys, json; print(json.dumps("%d.%d.%d" % sys.version_info[:3]))'], {
        timeout: 10_000,
        maxBuffer: 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
      })
      pythonVersion = JSON.parse(probe.stdout.trim())
    } catch (error) {
      throw new CapabilityError('python-runtime-missing', `Python 解释器无法执行：${messageOf(error)}`)
    }
    return { ...result.value, version: pythonVersion }
  }

  async executeTool(name, args, signal, purpose) {
    const callId = `capability-center-${purpose}-${randomUUID()}`
    if (typeof this.ctx.tools.setExecutor === 'function') {
      const response = await this.ctx.tools.execute({
        calls: [{
          type: 'tool-call',
          name,
          arguments: JSON.stringify(args ?? {}),
          id: callId,
        }],
        signal,
      })
      return response?.results?.[0]?.result
    }
    return await this.ctx.tools.execute({
      name,
      arguments: args ?? {},
      callId,
      signal,
    })
  }

  async pythonImport(runtime, module) {
    if (typeof module !== 'string' || !/^[A-Za-z_][A-Za-z0-9_.]*$/u.test(module)) {
      throw new CapabilityError('invalid-check', 'Python import 检查的模块名无效。')
    }
    const source = [
      'import importlib, importlib.metadata, json, sys',
      `module = importlib.import_module(${JSON.stringify(module)})`,
      'name = module.__name__.split(".")[0]',
      'try: version = importlib.metadata.version(name)',
      'except importlib.metadata.PackageNotFoundError: version = getattr(module, "__version__", None)',
      'print(json.dumps({"version": version, "origin": getattr(module, "__file__", None)}, ensure_ascii=False))',
    ].join('\n')
    try {
      const result = await runFile(runtime.python, ['-s', '-c', source], {
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      })
      return JSON.parse(result.stdout.trim())
    } catch (error) {
      throw new CapabilityError('python-check-failed', `Python 导入 ${module} 失败：${error?.stderr ?? messageOf(error)}`)
    }
  }

  async pythonKnownSafe(runtime, name) {
    if (name !== 'tabulate-table') {
      throw new CapabilityError('invalid-check', '未知的 Python 已知安全函数检查。')
    }
    try {
      const result = await runFile(runtime.python, ['-s', '-c', [
        'import json, tabulate',
        'print(tabulate.tabulate([["能力","状态"],["插件","已安装"],["技能","可使用"]], headers="firstrow", tablefmt="grid"))',
      ].join('\n')], {
        timeout: 20_000,
        maxBuffer: 2 * 1024 * 1024,
        windowsHide: true,
        encoding: 'utf8',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      })
      return result.stdout
    } catch (error) {
      throw new CapabilityError('python-check-failed', `已知安全 Python 函数检查失败：${messageOf(error)}`)
    }
  }

  async diagnose(item, operation) {
    const entry = this.ledger.get(item.id)
    if (entry === undefined) throw new CapabilityError('not-installed', '该能力尚未安装。')
    this.transition(operation, 'running', '运行有界检查', { progress: 0.45 })
    const health = await this.runChecks(item, entry)
    entry.latestHealth = health
    await this.ledger.write()
    if (health.status === 'ready' || health.status === 'restart-required') {
      return {
        status: health.status,
        phase: health.status === 'ready' ? '检查通过' : '等待重启',
        activation: health.status,
        output: health,
        log: health.detail,
      }
    }
    if (entry.legacy === true) {
      throw new CapabilityError('legacy-repair-required', `旧版安装已检测但不盲目重装：${health.detail}`)
    }
    const artifact = entry.artifacts?.[0]
    if (artifact === undefined || item.type === 'composite') {
      throw new CapabilityError('repair-unavailable', `${health.detail}；没有可用于自动修复的本地制品。`)
    }
    const bytes = await readFile(artifact)
    const before = this.ledger.snapshot()
    const journal = await this.ledger.begin({
      operationId: operation.id,
      action: 'repair',
      itemId: item.id,
      beforeVersion: entry.version,
      targetVersion: entry.version,
    })
    try {
      if (item.type === 'skill') {
        const repaired = await installSkill({
          item,
          bytes,
          dataRoot: this.dataRoot,
          dshHome: this.home,
          operationId: operation.id,
          beforeMutation: async intent => {
            await this.ledger.appendIntent(operation.id, { ...intent, itemId: item.id })
          },
        })
        this.ledger.get(item.id).ownedFiles = repaired.ownedFiles
        this.ledger.get(item.id).runtimeRoot = repaired.runtimeRoot
      } else if (item.type === 'python') {
        const runtime = await this.workspaceDependencies()
        const repaired = await installPython({
          item,
          bytes,
          dataRoot: this.dataRoot,
          pythonPackages: runtime.pythonPackages,
          operationId: operation.id,
          beforeMutation: async intent => {
            await this.ledger.appendIntent(operation.id, { ...intent, itemId: item.id })
          },
        })
        this.ledger.get(item.id).pythonPackages = repaired.pythonPackages
        this.ledger.get(item.id).runtimeRoot = repaired.runtimeRoot
        this.ledger.get(item.id).pth = repaired.pth
      } else {
        throw new CapabilityError('restart-required', `${health.detail}；插件修复需要重启后重新检查。`)
      }
      const repairedHealth = await this.runChecks(item, this.ledger.get(item.id))
      if (repairedHealth.status !== 'ready') {
        throw new CapabilityError('repair-check-failed', repairedHealth.detail)
      }
      this.ledger.get(item.id).latestHealth = repairedHealth
      await this.fault('child-repaired', { itemId: item.id, version: item.version })
      await this.ledger.commit(operation.id)
      return {
        status: 'ready',
        phase: '修复完成',
        activation: 'applied',
        output: repairedHealth,
        log: '使用本地缓存制品完成修复，并再次通过自动检查。',
      }
    } catch (error) {
      if (error?.simulatedCrash === true) {
        this.recoveryRequired = true
        this.recoveryMessages.push(`${operation.id}: 模拟进程在修复中途退出`)
        throw error
      }
      try {
        await this.rollbackJournalIntents(await this.latestJournal(operation.id))
        this.ledger.restore(before)
        await this.ledger.write()
        await this.resyncSkillsAfterRollback(await this.latestJournal(operation.id))
        await this.ledger.updateJournal(operation.id, { phase: 'rolled-back', failure: messageOf(error) })
        await this.ledger.close(operation.id)
      } catch (rollbackError) {
        this.recoveryRequired = true
        const message = `修复失败，且回滚无法完整证明：${messageOf(rollbackError)}`
        this.recoveryMessages.push(`${operation.id}: ${message}`)
        await this.ledger.updateJournal(operation.id, {
          phase: 'recovery-required',
          recoveryRequired: true,
          failure: messageOf(error),
          rollbackFailure: messageOf(rollbackError),
        }).catch(() => undefined)
        throw new CapabilityError('rollback-incomplete', `${messageOf(error)}；${message}`)
      }
      throw error
    }
  }

  async uninstall(item, operation) {
    const entry = this.ledger.get(item.id)
    if (entry === undefined) {
      return { status: 'ready', phase: '未安装', activation: 'removed', output: {}, log: '本机账本没有该能力。' }
    }
    if (entry.preexisting === true) {
      throw new CapabilityError('preexisting-preserved', '该安装来自能力中心之前的环境，已保留，不由能力中心移除。')
    }
    if ((entry.dependencyOwners ?? []).length > 0) {
      if (entry.rootInstalled === true) {
        const before = entry.dependencyOwners
        entry.rootInstalled = false
        await this.ledger.write()
        return {
          status: 'ready',
          phase: '直接引用已移除',
          activation: 'retained',
          output: { retainedFor: before },
          log: '该能力仍被组合能力使用，因此保留文件和依赖记录。',
        }
      }
      throw new CapabilityError('dependency-in-use', `该能力仍被 ${entry.dependencyOwners.join('、')} 使用。`)
    }
    const plan = planCapabilitiesFromStored(this.ledger, item.id)
    const journal = await this.ledger.begin({
      operationId: operation.id,
      action: 'uninstall',
      itemId: item.id,
      beforeVersion: entry.version,
    })
    let restartRequired = false
    const retiredRuntimes=[]
    try {
      for (const current of [...plan].reverse()) {
        const owned = this.ledger.get(current.id)
        if (owned === undefined) continue
        if (current.id !== item.id) {
          owned.dependencyOwners = (owned.dependencyOwners ?? []).filter(owner => owner !== item.id)
          if (owned.dependencyOwners.length > 0 || owned.rootInstalled === true) continue
        }
        if (owned.preexisting === true) {
          if (current.type === 'skill') this.unregisterSkill(current.id)
          delete this.ledger.value.entries[current.id]
          await this.ledger.addStep(operation.id, {
            step: 'borrowed-reference-released',
            itemId: current.id,
          })
          continue
        }
        for (const dependency of current.dependencies ?? []) {
          const child = this.ledger.get(dependency.id)
          if (child === undefined) continue
          child.dependencyOwners = (child.dependencyOwners ?? []).filter(owner => owner !== current.id)
        }
        this.transition(operation, 'running', `卸载 ${current.name}`, { progress: 0.3 })
        const result = await this.uninstallOne(current, owned, operation)
        if(owned.auxRuntime&&!result.restartRequired)retiredRuntimes.push({itemId:owned.id,version:owned.version,operationId:owned.auxRuntime.operationId})
        if (result.restartRequired) restartRequired = true
        delete this.ledger.value.entries[current.id]
        this.ledger.markMigrationTombstone(current.id, {
          type: current.type,
          version: owned.version,
          operationId: operation.id,
        })
        await this.ledger.addStep(operation.id, { step: `${current.type}-uninstalled`, itemId: current.id })
      }
      await this.ledger.commit(operation.id)
      await this.syncAllSkills()
      for(const runtime of retiredRuntimes)await removeRuntime(this.dataRoot,runtime).catch(()=>undefined)
      return {
        status: restartRequired ? 'restart-required' : 'ready',
        phase: restartRequired ? '已卸载，等待重启' : '卸载完成',
        activation: restartRequired ? 'restart-required' : 'removed',
        output: { removed: plan.map(current => current.id) },
        log: restartRequired
          ? '插件配置已移除；重启前旧运行态可能仍存在。'
          : '受管文件与依赖引用已安全移除。',
      }
    } catch (error) {
      if (error?.simulatedCrash === true) {
        this.recoveryRequired = true
        this.recoveryMessages.push(`${operation.id}: 模拟进程在卸载中途退出`)
        throw error
      }
      const journal = await this.latestJournal(operation.id).catch(() => undefined)
      try {
        if (journal !== undefined) await this.rollbackJournalIntents(journal)
        this.ledger.restore(journal?.beforeLedger ?? this.ledger.snapshot())
        await this.ledger.write()
        if (journal !== undefined) await this.resyncSkillsAfterRollback(journal)
        if (journal !== undefined) await this.ledger.close(operation.id)
      } catch (rollbackError) {
        this.recoveryRequired = true
        const message = `卸载失败，且回滚无法完整证明：${messageOf(rollbackError)}`
        this.recoveryMessages.push(`${operation.id}: ${message}`)
        await this.ledger.updateJournal(operation.id, {
          phase: 'recovery-required',
          recoveryRequired: true,
          failure: messageOf(error),
          rollbackFailure: messageOf(rollbackError),
        }).catch(() => undefined)
        throw new CapabilityError('rollback-incomplete', `${messageOf(error)}；${message}`)
      }
      throw error
    }
  }

  async uninstallOne(item, entry, operation) {
    if (item.type === 'skill') {
      this.unregisterSkill(item.id)
      const target = entry.legacy === true ? join(this.home, 'skills', item.id) : entry.runtimeRoot
      const removed = join(this.dataRoot, 'removed', `${item.id}-${operation.id}`)
      await this.ledger.appendIntent(operation.id, {
        kind: 'skill-uninstall',
        itemId: item.id,
        target,
        removed,
      })
      if (entry.legacy === true) {
        await removeOwnedTree({
          root: target,
          records: entry.ownedFiles,
          dataRoot: this.dataRoot,
          itemId: item.id,
          operationId: operation.id,
        })
      } else {
        await removeOwnedTree({
          root: entry.runtimeRoot,
          records: entry.ownedFiles,
          dataRoot: this.dataRoot,
          itemId: item.id,
          operationId: operation.id,
        })
      }
      await this.fault('capability-uninstalled', { itemId: item.id })
      return { restartRequired: false }
    }
    if (item.type === 'python') {
      if (entry.legacy === true) {
        if (typeof entry.pythonPackages !== 'string') {
          throw new CapabilityError('legacy-receipt-incomplete', '旧版 Python 回执缺少 pythonPackages，已保留现场。')
        }
        const removed = join(this.dataRoot, 'removed', `${item.id}-${operation.id}`)
        await this.ledger.appendIntent(operation.id, {
          kind: 'legacy-python-uninstall',
          itemId: item.id,
          root: entry.pythonPackages,
          removed,
          records: entry.ownedFiles.map(record => record.path),
        })
        await moveVerifiedFiles({
          root: entry.pythonPackages,
          records: entry.ownedFiles,
          dataRoot: this.dataRoot,
          itemId: item.id,
          operationId: operation.id,
        })
      } else {
        const runtime = await this.workspaceDependencies()
        const pth = join(runtime.pythonPackages, `capability-center-${item.id}.pth`)
        const previousPth = await readFile(pth, 'utf8')
        const removed = join(this.dataRoot, 'removed', `${item.id}-${operation.id}`)
        await this.ledger.appendIntent(operation.id, {
          kind: 'python-uninstall',
          itemId: item.id,
          pth,
          previousPth,
          runtimeRoot: entry.runtimeRoot,
          removed,
        })
        await uninstallPython({
          item,
          entry,
          dataRoot: this.dataRoot,
          pythonPackages: runtime.pythonPackages,
          operationId: operation.id,
        })
      }
      await this.fault('capability-uninstalled', { itemId: item.id })
      return { restartRequired: false }
    }
    if (item.type === 'plugin') {
      const manager = this.pluginManager()
      if (entry.legacy === true || entry.preexisting === true) {
        throw new CapabilityError('preexisting-preserved', '该插件来自旧环境，能力中心保留其安装。')
      }
      if (typeof entry.artifacts?.[0] !== 'string') {
        throw new CapabilityError('previous-artifact-missing', '插件旧版缓存缺失，无法在失败时恢复，拒绝卸载。')
      }
      await this.ledger.appendIntent(operation.id, {
        kind: 'plugin-remove',
        itemId: item.id,
        packageName: item.install.packageName,
        beforeVersion: entry.version,
        beforeArchive: entry.artifacts[0],
      })
      const result = await manager.removeBundle(item.install.packageName)
      if (!['applied', 'restart-required'].includes(result?.application)) {
        throw new CapabilityError('plugin-uninstall-failed', `插件卸载失败：${result?.error?.diagnostic ?? result?.application}`)
      }
      await this.fault('capability-uninstalled', { itemId: item.id })
      return { restartRequired: result.application === 'restart-required' }
    }
    if (item.type === 'composite') return { restartRequired: false }
    throw new CapabilityError('unsupported-type', '不支持的能力类型。')
  }

  async prepareTrial(serverUrl, itemId, requestId, source, origin) {
    if (this.disposed || !this.acceptingWork) {
      throw new CapabilityError('disposed', '能力中心核心正在关闭或切换。')
    }
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
      throw new CapabilityError('invalid-request', '试用请求 ID 无效。')
    }
    if (typeof source !== 'string' || source.length > 200 || typeof origin !== 'string' || origin.length > 300) {
      throw new CapabilityError('invalid-request', '试用来源信息无效。')
    }
    const dedupKey = `${requestId}\0${itemId}\0${source}\0${origin}`
    if (this.trials.has(dedupKey)) return this.trials.get(dedupKey)
    if ([...this.trials.keys()].some(key => key.startsWith(`${requestId}\0`))) {
      throw new CapabilityError('duplicate-request', '该试用请求已经使用。')
    }
    let online
    try { online = await this.catalog(serverUrl) } catch { online = undefined }
    const managed = this.ledger.get(itemId)
    const item = managed === undefined
      ? online?.items.find(candidate => candidate.id === itemId)
      : localDisplayItem(managed)
    if (item === undefined) throw new CapabilityError('unknown-item', '没有可用的试用定义。')
    if (item.hidden === true) {
      throw new CapabilityError(
        'component-only',
        '隐藏组件不能单独试用，请使用 office-enhancement。',
      )
    }
    if (item.id === AUTO_CONTINUE_ID) {
      throw new CapabilityError('trial-unavailable', '自动续跑会在实际会话中生效。')
    }
    const entry = this.ledger.get(itemId)
    const state = await this.quickState(item, entry)
    if (!state.ready) throw new CapabilityError('not-ready', state.detail || '能力尚未通过检查。')
    const prompt = item.trial?.prompt
    if (typeof prompt !== 'string' || prompt.trim() === '' || prompt.length > MAX_PROMPT_LENGTH
      || prompt.includes('\0')) {
      throw new CapabilityError('invalid-trial', '试用提示词未通过长度与内容检查。')
    }
    const result = {
      requestId,
      itemId,
      prompt,
      origin,
      source,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
    }
    this.trials.set(dedupKey, result)
    if (this.trials.size > 100) this.trials.delete(this.trials.keys().next().value)
    return result
  }

  getOperation(id) {
    const operation = this.operations.get(id)
    if (operation === undefined) throw new CapabilityError('unknown-operation', '找不到该操作。')
    return this.publicOperation(operation)
  }

  async waitForOperation(id) {
    const operation = this.operations.get(id)
    if (operation === undefined) throw new CapabilityError('unknown-operation', '找不到该操作。')
    await operation.done
    return this.publicOperation(operation)
  }

  transition(operation, status, phase, extra = {}) {
    if (status === 'running' && operation.phase !== phase) this.log(operation, phase)
    Object.assign(operation, extra, { status, phase, updatedAt: new Date().toISOString() })
  }

  log(operation, message) {
    operation.logs.push({ at: new Date().toISOString(), message })
    if (operation.logs.length > 100) operation.logs.splice(0, operation.logs.length - 100)
  }

  publicOperation(operation) {
    return {
      id: operation.id,
      action: operation.action,
      itemId: operation.itemId,
      status: operation.status,
      terminal: TERMINAL.has(operation.status),
      phase: operation.phase,
      progress: operation.progress,
      activation: operation.activation,
      error: operation.error,
      output: operation.output,
      logs: operation.logs.map(entry => ({ ...entry })),
      createdAt: operation.createdAt,
      updatedAt: operation.updatedAt,
    }
  }

  async coreStatus() {
    const state = await readJson(join(this.dataRoot, 'engine-state.json'), {})
    return {
      ...state,
      activeVersion: this.version,
      ready: true,
      protocolVersion: 1,
      targetDsh: '0.2.1-rc.2',
      recoveryRequired: this.recoveryRequired,
      recoveryMessages: this.recoveryMessages,
      refreshBridge: this.runtime.refreshBridge,
    }
  }

  async updateSummary(serverUrl, {force=true,configure=true}={}) {
    if(configure) await this.configureCatalog(serverUrl)
    const localCore = typeof this.runtime.coreStatus === 'function'
      ? await this.runtime.coreStatus()
      : await this.coreStatus()
    const core = {
      activeVersion: localCore.activeVersion ?? this.version,
      pendingVersion: localCore.pending?.version ?? null,
      latestVersion: null,
      updateAvailable: false,
    }
    if (typeof serverUrl === 'string' && serverUrl.trim() !== ''
      && typeof this.runtime.coreCheck === 'function') {
      const source=normalizeServerUrl(serverUrl)
      let cached=this.coreUpdateCache.get(source)
      if(force || !cached || Date.now()-cached.at>15*60_000){
        try{
          cached={at:Date.now(),value:await this.runtime.coreCheck(source)}
          this.coreUpdateCache.set(source,cached)
        }catch{/* Retain last confirmed version. */}
      }
      if(cached){
        core.latestVersion=cached.value.latestVersion??null
        core.updateAvailable=core.latestVersion!==null && compareVersions(core.latestVersion,core.activeVersion)>0
      }
    }

    const items = {}
    let snapshot={}
    if (typeof serverUrl === 'string' && serverUrl.trim() !== '') {
      try { await this.catalog(serverUrl,{force}) } catch { /* Last-good snapshot remains. */ }
      snapshot=await this.catalogSync.snapshot(serverUrl)
      const online=snapshot.catalog
      if(online){
        for (const entry of this.ledger.list()) {
          const candidate = online.items.find(item => item.id === entry.id)
          if (candidate === undefined) continue
          const local = localDisplayItem(entry)
          if (candidate.hidden === true || local.hidden === true || compatibilityError({...candidate,compatibility:{...candidate.compatibility,python:undefined}})) continue
          const updateAvailable = compareVersions(candidate.version, entry.version) > 0
          if (!updateAvailable) continue
          items[entry.id] = {
            name: candidate.name,
            installedVersion: entry.version,
            latestVersion: candidate.version,
            updateAvailable: true,
          }
        }
      }
    }
    const unread=(snapshot.unread??[]).filter(id=>!this.ledger.get(id))
    const revoked=(snapshot.catalog?.revocations??[]).filter(v=>this.ledger.get(v.id)?.version===v.version)
    return {
      attention: core.pendingVersion !== null || core.updateAvailable || Object.keys(items).length > 0 || unread.length>0 || revoked.length>0,
      offline: !(typeof serverUrl === 'string' && serverUrl.trim() !== ''),
      core, items, unread, revoked,
      lastSyncedAt:snapshot.lastSyncedAt??null,
      stale:snapshot.stale===true,
    }
  }

  async refreshState(itemId) {
    const core = typeof this.runtime.coreStatus === 'function'
      ? await this.runtime.coreStatus()
      : await this.coreStatus()
    const plugins = {}
    for (const entry of this.ledger.list()) {
      if (entry.type !== 'plugin') continue
      if (typeof itemId === 'string' && itemId !== '' && entry.id !== itemId) continue
      const item = localDisplayItem(entry)
      const health = await this.checkPluginBundle(item, {
        ...entry,
        bundle: entry.bundle === undefined ? undefined : { ...entry.bundle },
      }).catch(error => ({
        status: 'failed',
        detail: messageOf(error),
      }))
      const ready = health.status === 'ready'
      plugins[entry.id] = {
        name: item.name,
        version: entry.version,
        currentVersion: entry.version,
        ready,
        activation: health.status,
      }
    }
    return {
      core: {
        ready: core.ready === true,
        activeVersion: core.activeVersion ?? null,
        pendingVersion: core.pending?.version ?? null,
      },
      plugins,
    }
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
    let value
    try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')) } catch {
      throw Object.assign(new Error('请求体必须是 JSON 对象。'), { status: 400 })
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw Object.assign(new Error('请求体必须是 JSON 对象。'), { status: 400 })
    }
    return value
  }

  sendJson(res, status, value) {
    const body = Buffer.from(JSON.stringify(value))
    res.statusCode = status
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
    res.setHeader('content-length', String(body.byteLength))
    res.setHeader('x-content-type-options', 'nosniff')
    res.end(body)
  }

  async handle(req, res, route, url) {
    try {
      if (route === '/api/core/status') {
        this.sendJson(res, 200, await this.coreStatus())
        return true
      }
      if (route === '/api/config') {
        if (req.method !== 'GET') throw Object.assign(new Error('Method not allowed'), { status: 405 })
        this.sendJson(res, 200, { ...(this.feedbackEmail===undefined?{}:{feedbackEmail:this.feedbackEmail}), ...(process.env.DSH_CATALOG_URL?{catalogUrl:normalizeServerUrl(process.env.DSH_CATALOG_URL)}:{}) })
        return true
      }
      if (route === '/api/updates') {
        if (req.method !== 'GET') throw Object.assign(new Error('Method not allowed'), { status: 405 })
        this.sendJson(res, 200, await this.updateSummary(url.searchParams.get('offline')==='1'?'':(url.searchParams.get('server')??this.catalogSync.source), {force:false}))
        return true
      }
      if (route === '/api/updates/read') {
        if (req.method !== 'POST') throw Object.assign(new Error('Method not allowed'), { status: 405 })
        const body=await this.bodyJson(req)
        if(!Array.isArray(body.ids)||body.ids.length>100||!body.ids.every(id=>typeof id==='string'&&/^[a-z0-9][a-z0-9-]{0,63}$/.test(id))) throw new CapabilityError('invalid-ids','无效能力 ID。')
        await this.catalogSync.markRead(body.serverUrl,body.ids)
        this.sendJson(res,200,await this.updateSummary(body.serverUrl,{force:false,configure:false}))
        return true
      }
      if (route === '/api/refresh-state') {
        if (req.method !== 'GET') throw Object.assign(new Error('Method not allowed'), { status: 405 })
        this.sendJson(res, 200, await this.refreshState(url.searchParams.get('itemId') ?? undefined))
        return true
      }
      if (route === '/api/status') {
        if (req.method !== 'GET') throw Object.assign(new Error('Method not allowed'), { status: 405 })
        this.sendJson(res, 200, await this.inspect(url.searchParams.get('offline')==='1'?'':(url.searchParams.get('server')??this.catalogSync.source)))
        return true
      }
      if (route.startsWith('/api/operations/')) {
        if (req.method !== 'GET') throw Object.assign(new Error('Method not allowed'), { status: 405 })
        const id = route.slice('/api/operations/'.length)
        if (!/^[0-9a-f-]{36}$/u.test(id)) throw new CapabilityError('unknown-operation', '操作 ID 无效。')
        this.sendJson(res, 200, { operation: this.getOperation(id) })
        return true
      }
      if (route === '/api/actions/install' || route === '/api/actions/update'
        || route === '/api/actions/uninstall' || route === '/api/actions/diagnose') {
        if (req.method !== 'POST') throw Object.assign(new Error('Method not allowed'), { status: 405 })
        const body = await this.bodyJson(req)
        const action = route.slice('/api/actions/'.length)
        const operation = this.startAction(body.serverUrl, body.itemId, action)
        this.sendJson(res, 202, { operation })
        return true
      }
      if (route === '/api/trials/prepare') {
        if (req.method !== 'POST') throw Object.assign(new Error('Method not allowed'), { status: 405 })
        const body = await this.bodyJson(req)
        const origin = String(req.headers.origin ?? `http://${req.headers.host ?? 'localhost'}`)
        const prepared = await this.prepareTrial(
          body.serverUrl,
          body.itemId,
          body.requestId,
          body.source,
          origin,
        )
        this.sendJson(res, 200, prepared)
        return true
      }
      if (route.startsWith('/api/')) {
        this.sendJson(res, 404, { code: 'not-found', message: 'API 路径不存在。' })
        return true
      }
      if (STATIC.has(route)) {
        if (!['GET', 'HEAD'].includes(req.method)) {
          res.statusCode = 405
          res.setHeader('allow', 'GET, HEAD')
          res.end()
          return true
        }
        const [file, type] = STATIC.get(route)
        let body = await readFile(join(PAGE_ROOT, file))
        if (file === 'index.html' && typeof this.devDistributionUrl === 'string') {
          const meta = `<meta name="capability-center-dev-distribution-url" content="${
            this.devDistributionUrl
              .replaceAll('&', '&amp;')
              .replaceAll('"', '&quot;')
              .replaceAll('<', '&lt;')
              .replaceAll('>', '&gt;')
          }">`
          body = Buffer.from(body.toString('utf8').replace('</head>', `  ${meta}\n</head>`))
        }
        res.statusCode = 200
        res.setHeader('content-type', type)
        res.setHeader('cache-control', 'no-cache')
        res.setHeader('content-length', String(body.byteLength))
        res.setHeader('content-security-policy',
          "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
          + "connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'")
        res.setHeader('x-content-type-options', 'nosniff')
        res.setHeader('referrer-policy', 'no-referrer')
        if (req.method === 'HEAD') res.end()
        else res.end(body)
        return true
      }
      return false
    } catch (error) {
      const status = Number(error?.status)
      this.sendJson(res, Number.isInteger(status) && status >= 400 && status < 600 ? status : 500, {
        code: error?.code ?? 'internal-error',
        message: messageOf(error),
        details: error?.details,
      })
      return true
    }
  }

  async dispose() {
    this.stopAcceptingWork()
    this.disposed = true
    await this.drain()
    for (const dispose of this.skillDisposers.values()) dispose()
    this.skillDisposers.clear()
  }
}

function planCapabilitiesFromStored(ledger, rootId) {
  const root = ledger.get(rootId)
  if (root === undefined) throw new CapabilityError('not-installed', '账本中没有该能力。')
  const visited = new Set()
  const result = []
  function visit(entry) {
    if (visited.has(entry.id)) return
    visited.add(entry.id)
    for (const dependency of entry.manifest.dependencies ?? []) visit(ledger.get(dependency.id))
    result.push(entry.manifest)
  }
  visit(root)
  return result
}
