import { safeRelativePath } from './archive.js'
import { satisfies } from './semver.js'

export const CATALOG_SCHEMA_VERSION = 2
export const MAX_ITEMS = 100
export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024
export const MAX_PROMPT_LENGTH = 4_000
const ID = /^[a-z0-9][a-z0-9-]{0,63}$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]{0,100}\/)?[a-z0-9][a-z0-9._-]{0,100}$/u
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u
const SHA256 = /^[a-f0-9]{64}$/u

export class CapabilityError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'CapabilityError'
    this.code = code
    this.details = details
  }
}

export function normalizeServerUrl(raw) {
  const value = String(raw ?? '').trim()
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid')
    }
    url.pathname = `${url.pathname.replace(/\/+$/u, '')}/`
    return url.href
  } catch {
    throw new CapabilityError('invalid-server', '服务器地址必须是完整且不含账号、查询参数或锚点的 http(s) URL。')
  }
}

function validUsage(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Array.isArray(value.steps) && value.steps.length >= 2 && value.steps.length <= 8
    && value.steps.every(step => typeof step === 'string' && step.trim() !== '' && step.length <= 500)
    && typeof value.inputs === 'string' && value.inputs.length > 0 && value.inputs.length <= 1_200
    && typeof value.output === 'string' && value.output.length > 0 && value.output.length <= 1_200
    && typeof value.example === 'string' && value.example.length > 0 && value.example.length <= 2_400
}

function validCompatibility(value) {
  if (value === undefined) return true
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value.dsh === undefined || typeof value.dsh === 'string')
    && (value.python === undefined || typeof value.python === 'string')
    && (value.os === undefined || (Array.isArray(value.os) && value.os.every(os => ['win32', 'darwin', 'linux'].includes(os))))
    && (value.arch === undefined || (Array.isArray(value.arch) && value.arch.every(arch => ['x64', 'arm64', 'ia32'].includes(arch))))
}

function validCheck(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  if (value.type === 'office-smoke') return Object.keys(value).length === 1
  if (value.type === 'plugin-bundle') return Object.keys(value).length === 1
  if (value.type === 'skill-discovery') return value.name === undefined || ID.test(value.name)
  if (value.type === 'named-tool-readonly-call') {
    return typeof value.tool === 'string' && /^[A-Za-z_][A-Za-z0-9_.-]{0,100}$/u.test(value.tool)
  }
  if (value.type === 'python-import') {
    return typeof value.module === 'string' && /^[A-Za-z_][A-Za-z0-9_.]*$/u.test(value.module)
      && (value.version === undefined || typeof value.version === 'string')
  }
  if (value.type === 'python-function') {
    return typeof value.name === 'string'
      && ['tabulate-table'].includes(value.name)
      && (value.module === undefined || (typeof value.module === 'string' && /^[A-Za-z_][A-Za-z0-9_.]*$/u.test(value.module)))
  }
  return false
}

function validDependency(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof value.id === 'string' && ID.test(value.id)
    && typeof value.version === 'string' && VERSION.test(value.version)
}

function validateItem(item, index, base) {
  if (typeof item !== 'object' || item === null || Array.isArray(item)
    || typeof item.id !== 'string' || !ID.test(item.id)
    || !['skill', 'plugin', 'python', 'composite'].includes(item.type)
    || typeof item.name !== 'string' || item.name.length === 0 || item.name.length > 100
    || typeof item.version !== 'string' || !VERSION.test(item.version)
    || typeof item.description !== 'string' || item.description.length === 0 || item.description.length > 1_200
    || !validCompatibility(item.compatibility)
    || !validUsage(item.usage)
    || !Array.isArray(item.checks) || item.checks.length === 0 || item.checks.length > 8
    || !item.checks.every(validCheck)
    || (item.hidden !== undefined && typeof item.hidden !== 'boolean')
    || (item.category !== undefined && item.category !== 'mcp')
    || (item.dependencies !== undefined && (!Array.isArray(item.dependencies) || item.dependencies.length > 32
      || !item.dependencies.every(validDependency)))
    || typeof item.trial !== 'object' || item.trial === null || Array.isArray(item.trial)
    || typeof item.trial.prompt !== 'string' || item.trial.prompt.trim() === ''
    || item.trial.prompt.length > MAX_PROMPT_LENGTH || item.trial.prompt.includes('\0')) {
    throw new CapabilityError('invalid-catalog', `能力目录第 ${index + 1} 项无效。`)
  }
  if (item.type === 'composite') {
    if (!Array.isArray(item.dependencies) || item.dependencies.length === 0 || item.artifact !== undefined) {
      throw new CapabilityError('invalid-catalog', `组合能力 ${item.id} 必须包含至少一个固定依赖且不能声明制品。`)
    }
  } else {
    if (typeof item.artifact !== 'object' || item.artifact === null || Array.isArray(item.artifact)
      || !safeRelativePath(item.artifact.path)
      || typeof item.artifact.sha256 !== 'string' || !SHA256.test(item.artifact.sha256)
      || !Number.isSafeInteger(item.artifact.bytes) || item.artifact.bytes <= 0
      || item.artifact.bytes > MAX_ARTIFACT_BYTES) {
      throw new CapabilityError('invalid-catalog', `能力 ${item.id} 的制品声明无效。`)
    }
  }
  if (item.checks.some(check => check.type === 'office-smoke')
    && (item.id !== 'office-enhancement' || item.type !== 'composite')) {
    throw new CapabilityError(
      'invalid-catalog',
      'office-smoke 只能用于固定的 office-enhancement 组合能力。',
    )
  }
  if (item.checks.some(check => check.type === 'plugin-bundle') && item.type !== 'plugin') {
    throw new CapabilityError(
      'invalid-catalog',
      'plugin-bundle 只能用于插件能力。',
    )
  }
  if (item.type === 'plugin') {
    if (typeof item.install?.packageName !== 'string'
      || !PACKAGE_NAME.test(item.install.packageName)) {
      throw new CapabilityError('invalid-catalog', `插件 ${item.id} 缺少固定 packageName。`)
    }
  }
  if (item.category === 'mcp' && item.type !== 'plugin') {
    throw new CapabilityError(
      'invalid-catalog',
      `MCP 分类只能标注随 DSH 插件注册 MCP 的插件：${item.id}。`,
    )
  }
  if (item.type === 'python') {
    if (typeof item.install?.distribution !== 'string'
      || typeof item.install?.module !== 'string'
      || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(item.install.module)
      || item.install.wheelTag !== 'py3-none-any') {
      throw new CapabilityError('invalid-catalog', `Python 能力 ${item.id} 只支持 py3-none-any 纯 Python wheel。`)
    }
  }
  const artifactUrl = item.artifact === undefined
    ? undefined
    : new URL(item.artifact.path, base)
  if (artifactUrl !== undefined && artifactUrl.origin !== new URL(base).origin) {
    throw new CapabilityError('invalid-catalog', `能力 ${item.id} 的制品必须来自内网目录同源服务器。`)
  }
  return Object.freeze({
    ...item,
    artifact: artifactUrl === undefined
      ? undefined
      : Object.freeze({ ...item.artifact, url: artifactUrl.href }),
    dependencies: Object.freeze((item.dependencies ?? []).map(dependency => Object.freeze({ ...dependency }))),
    checks: Object.freeze(item.checks.map(check => Object.freeze({ ...check }))),
    usage: Object.freeze({ ...item.usage, steps: Object.freeze([...item.usage.steps]) }),
    trial: Object.freeze({ ...item.trial }),
    compatibility: Object.freeze({ ...(item.compatibility ?? {}) }),
  })
}

export function validateCatalog(value, base) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || value.schemaVersion !== CATALOG_SCHEMA_VERSION
    || !Array.isArray(value.items) || value.items.length > MAX_ITEMS) {
    throw new CapabilityError('invalid-catalog', '能力目录版本或条目数量无效。')
  }
  const ids = new Set()
  const items = value.items.map((item, index) => {
    if (ids.has(item?.id)) throw new CapabilityError('invalid-catalog', `能力 ID 重复：${item.id}`)
    ids.add(item?.id)
    return validateItem(item, index, base)
  })
  return Object.freeze({
    schemaVersion: CATALOG_SCHEMA_VERSION,
    name: typeof value.name === 'string' ? value.name.slice(0, 120) : '内网能力目录',
    generatedFor: typeof value.generatedFor === 'string' ? value.generatedFor : 'dsh-v0.2.1-rc.2',
    items: Object.freeze(items),
  })
}

export async function fetchCatalog(serverUrl, http) {
  const base = normalizeServerUrl(serverUrl)
  const response = await http.readBoundedUrl(new URL('catalog.json', base), {
    timeoutMs: 15_000,
    maxBytes: 1024 * 1024,
    headers: { accept: 'application/json' },
  })
  let value
  try {
    value = JSON.parse(response.body.toString('utf8'))
  } catch {
    throw new CapabilityError('invalid-catalog', '能力目录不是有效 JSON。')
  }
  return validateCatalog(value, base)
}

export function itemById(catalog, itemId) {
  const item = catalog.items.find(candidate => candidate.id === itemId)
  if (item === undefined) throw new CapabilityError('unknown-item', `目录中不存在条目：${itemId}`)
  return item
}

export function compatibilityError(item, {
  dsh = '0.2.1-rc.2',
  platform = process.platform,
  arch = process.arch,
  pythonVersion,
} = {}) {
  const compatibility = item.compatibility ?? {}
  if (compatibility.dsh !== undefined && !satisfies(dsh, compatibility.dsh)) {
    return `需要 DSH ${compatibility.dsh}，当前为 ${dsh}`
  }
  if (compatibility.os !== undefined && !compatibility.os.includes(platform)) {
    return `不支持当前操作系统 ${platform}`
  }
  if (compatibility.arch !== undefined && !compatibility.arch.includes(arch)) {
    return `不支持当前架构 ${arch}`
  }
  if (compatibility.python !== undefined && (pythonVersion === undefined || !satisfies(pythonVersion, compatibility.python))) {
    return `需要 Python ${compatibility.python}，当前为 ${pythonVersion ?? '不可用'}`
  }
  return undefined
}

export function serializableItem(item) {
  const { artifact, ...rest } = item
  return {
    ...rest,
    artifact: artifact === undefined ? undefined : {
      path: artifact.path,
      sha256: artifact.sha256,
      bytes: artifact.bytes,
    },
  }
}
