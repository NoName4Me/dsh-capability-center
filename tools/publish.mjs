#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto'
import {
  access,
  copyFile,
  mkdir,
  open,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { readZip, safeRelativePath } from '../apps/dsh-plugin/core/lib/archive.js'
import { validateGraph } from '../apps/dsh-plugin/core/lib/graph.js'
import { validateCatalog, CapabilityError } from '../apps/dsh-plugin/core/lib/manifest.js'
import { compareVersions, parseVersion } from '../apps/dsh-plugin/core/lib/semver.js'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CORE_PROTOCOL = 1
const TARGET_DSH = 'dsh-v0.2.1-rc.2'

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${process.pid}-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o644)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
}

async function atomicJson(path, value) {
  await atomicWrite(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'))
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .filter(key => value[key] !== undefined)
        .sort()
        .map(key => [key, canonical(value[key])]),
    )
  }
  return value
}

function manifestDigest(item) {
  return sha256(Buffer.from(JSON.stringify(canonical(item)), 'utf8'))
}

async function loadRegistry(storage) {
  const path = join(storage, 'publication-registry.json')
  try {
    const value = JSON.parse(await readFile(path, 'utf8'))
    if (value?.schemaVersion !== 1
      || typeof value.entries !== 'object'
      || value.entries === null
      || Array.isArray(value.entries)) {
      throw new CapabilityError('invalid-publication-registry', '发布历史注册表格式无效。')
    }
    return {
      path,
      value: {
        schemaVersion: 1,
        entries: value.entries,
        updatedAt: value.updatedAt,
      },
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return {
      path,
      value: {
        schemaVersion: 1,
        entries: {},
        updatedAt: undefined,
      },
    }
  }
}

function reservePublication(registry, key, candidate) {
  const existing = Object.hasOwn(registry.value.entries, key)
    ? registry.value.entries[key]
    : undefined
  if (existing !== undefined
    && (existing.manifestSha256 !== candidate.manifestSha256
      || existing.path !== candidate.path
      || existing.sha256 !== candidate.sha256
      || existing.bytes !== candidate.bytes)) {
    throw new CapabilityError(
      'publication-immutable-conflict',
      `${key} 已发布过不同内容；同版本必须保持清单、路径、字节数和哈希不变。`,
    )
  }
  if (existing !== undefined) return false
  registry.value.entries[key] = existing ?? {
    ...candidate,
    publishedAt: new Date().toISOString(),
  }
  return true
}

async function saveRegistry(registry, changed) {
  if (changed || registry.value.updatedAt === undefined) {
    registry.value.updatedAt = new Date().toISOString()
  }
  await atomicJson(registry.path, registry.value)
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function immutableArtifactPath(item) {
  const name = basename(item.artifact.path)
  if (!item.artifact.path.startsWith('packages/')
    || item.artifact.path !== `packages/${name}`
    || !safeRelativePath(item.artifact.path)
    || !name.includes(item.version)) {
    throw new CapabilityError(
      'non-immutable-path',
      `${item.id} 的制品路径必须为 packages/<文件名含版本>.zip|tgz|whl。`,
    )
  }
}

function options(args, defaults) {
  const { values } = parseArgs({
    args,
    options: {
      storage: { type: 'string', default: defaults.storage },
      catalog: { type: 'string' },
      archive: { type: 'string' },
      'base-url': { type: 'string', default: 'http://publisher.invalid/' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  })
  return values
}

async function publishCatalog(values) {
  const storage = resolve(values.storage)
  const input = resolve(values.catalog ?? join(storage, 'catalog.json'))
  const source = JSON.parse(await readFile(input, 'utf8'))
  const catalog = validateCatalog(source, values['base-url'])
  validateGraph(catalog)
  const registry = await loadRegistry(storage)
  let registryChanged = false
  const normalizedItems = []
  const reservations = []
  for (const item of catalog.items) {
    if (item.type === 'composite') {
      const normalized = {
        ...JSON.parse(JSON.stringify(item)),
        artifact: undefined,
      }
      normalizedItems.push(normalized)
      reservations.push(['composite', normalized])
      continue
    }
    immutableArtifactPath(item)
    const file = join(storage, ...item.artifact.path.split('/'))
    const bytes = await readFile(file)
    if (bytes.byteLength !== item.artifact.bytes || sha256(bytes) !== item.artifact.sha256) {
      throw new CapabilityError(
        'artifact-mismatch',
        `${item.id} 的声明字节数或 SHA-256 与 ${item.artifact.path} 不一致。`,
      )
    }
    const normalized = {
      ...JSON.parse(JSON.stringify(item)),
      artifact: {
        path: item.artifact.path,
        sha256: item.artifact.sha256,
        bytes: item.artifact.bytes,
      },
    }
    normalizedItems.push(normalized)
    reservations.push([item.type, normalized])
  }
  for (const [type, item] of reservations) {
    registryChanged = reservePublication(registry, `${item.id}@${item.version}`, {
      kind: 'capability',
      type,
      id: item.id,
      version: item.version,
      path: item.artifact?.path ?? null,
      sha256: item.artifact?.sha256 ?? null,
      bytes: item.artifact?.bytes ?? null,
      manifestSha256: manifestDigest(item),
    }) || registryChanged
  }
  const output = {
    schemaVersion: 2,
    name: catalog.name,
    generatedFor: catalog.generatedFor,
    items: normalizedItems,
  }
  const target = join(storage, 'catalog.json')
  // The append-only registry is the publication authority. Persist its
  // reservations first so a crash cannot later reinterpret an existing version.
  await saveRegistry(registry, registryChanged)
  await atomicJson(target, output)
  await updateCatalogManifest(storage, target)
  return {
    published: 'catalog',
    target,
    items: output.items.length,
    sha256: sha256(await readFile(target)),
  }
}

async function updateCatalogManifest(storage, catalogPath) {
  const path = join(storage, 'artifact-manifest.json')
  let manifest = {}
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  manifest.catalogSha256 = sha256(await readFile(catalogPath))
  await atomicJson(path, manifest)
}

function validateCore(manifest) {
  if (manifest?.schemaVersion !== 1
    || manifest.name !== 'capability-center-core'
    || parseVersion(manifest.version) === null
    || manifest.protocolVersion !== CORE_PROTOCOL
    || manifest.entry !== 'engine/index.js'
    || manifest.compatibility?.dsh !== '0.2.1-rc.2'
    || !Array.isArray(manifest.compatibility?.os)
    || !Array.isArray(manifest.compatibility?.arch)) {
    throw new CapabilityError('invalid-core', '核心 manifest.json 协议、版本或 rc.2 兼容声明无效。')
  }
}

async function publishCore(values) {
  if (typeof values.archive !== 'string') {
    throw new CapabilityError('missing-archive', 'core 发布需要 --archive <capability-center-core-X.Y.Z.zip>。')
  }
  const storage = resolve(values.storage)
  const sourcePath = resolve(values.archive)
  const bytes = await readFile(sourcePath)
  const files = readZip(bytes)
  const manifestBytes = files.get('manifest.json')
  if (manifestBytes === undefined || files.get('package.json') === undefined
    || files.get('engine/index.js') === undefined
    || files.get('page/index.html') === undefined) {
    throw new CapabilityError('invalid-core', '核心 ZIP 缺少固定协议文件。')
  }
  const packageJson = JSON.parse(files.get('package.json').toString('utf8'))
  if (packageJson.type !== 'module') {
    throw new CapabilityError('invalid-core', '核心 ZIP 的 package.json 必须声明 type: module。')
  }
  const manifest = JSON.parse(manifestBytes.toString('utf8'))
  validateCore(manifest)
  const digest = sha256(bytes)
  const outputName = `capability-center-core-${manifest.version}.zip`
  const outputPath = join(storage, 'core', outputName)
  if (await exists(outputPath)) {
    const existing = await readFile(outputPath)
    if (sha256(existing) !== digest) {
      throw new CapabilityError(
        'release-immutable-conflict',
        `核心 ${manifest.version} 已发布为不同制品；请提升版本号。`,
      )
    }
  } else {
    await mkdir(dirname(outputPath), { recursive: true })
    const temporary = join(dirname(outputPath), `.${randomUUID()}.tmp`)
    await copyFile(sourcePath, temporary)
    await rename(temporary, outputPath)
  }

  const registry = await loadRegistry(storage)
  const registryChanged = reservePublication(registry, `core@${manifest.version}`, {
    kind: 'core',
    type: 'core',
    id: 'capability-center-core',
    version: manifest.version,
    path: `core/${outputName}`,
    sha256: digest,
    bytes: bytes.byteLength,
    manifestSha256: manifestDigest(manifest),
  })
  await saveRegistry(registry, registryChanged)

  const indexPath = join(storage, 'core-release-index.json')
  let index = {
    schemaVersion: 1,
    name: '能力中心核心版本',
    protocolVersion: CORE_PROTOCOL,
    targetDsh: TARGET_DSH,
    releases: [],
  }
  if (await exists(indexPath)) index = JSON.parse(await readFile(indexPath, 'utf8'))
  if (index.protocolVersion !== CORE_PROTOCOL || !Array.isArray(index.releases)) {
    throw new CapabilityError('invalid-core-index', '现有核心版本索引格式无效。')
  }
  const sameVersion = index.releases.find(release => release.version === manifest.version)
  if (sameVersion !== undefined
    && (sameVersion.sha256 !== digest || sameVersion.bytes !== bytes.byteLength)) {
    throw new CapabilityError(
      'release-immutable-conflict',
      `核心版本索引中的 ${manifest.version} 与待发布制品不同。`,
    )
  }
  const release = {
    version: manifest.version,
    archive: `core/${outputName}`,
    sha256: digest,
    bytes: bytes.byteLength,
    compatibility: {
      dsh: '0.2.1-rc.2',
      os: manifest.compatibility.os,
      arch: manifest.compatibility.arch,
    },
  }
  index.releases = [
    ...index.releases.filter(candidate => candidate.version !== manifest.version),
    release,
  ].sort((left, right) => compareVersions(right.version, left.version))
  await atomicJson(indexPath, index)

  const artifactPath = join(storage, 'artifact-manifest.json')
  let artifactManifest = {}
  try {
    artifactManifest = JSON.parse(await readFile(artifactPath, 'utf8'))
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  artifactManifest.coreReleaseIndexSha256 = sha256(await readFile(indexPath))
  artifactManifest.core = { path: relative(storage, outputPath), bytes: bytes.byteLength, sha256: digest }
  await atomicJson(artifactPath, artifactManifest)
  return { published: 'core', target: outputPath, version: manifest.version, sha256: digest }
}

function usage() {
  return `Usage:
  node tools/publish.mjs catalog --storage <dist> [--catalog <catalog.json>] [--base-url <url>]
  node tools/publish.mjs core --storage <dist> --archive <core.zip>

The publisher validates manifests, flat dependency graphs, immutable versioned paths,
byte counts, hashes, and core protocol/rc.2 compatibility before atomic metadata writes.`
}

async function main() {
  const command = process.argv[2]
  if (command === undefined || command === '-h' || command === '--help') {
    console.log(usage())
    return
  }
  if (!['catalog', 'core'].includes(command)) throw new Error(`未知发布命令：${command}`)
  const values = options(process.argv.slice(3), { storage: join(root, 'dist') })
  if (values.help) {
    console.log(usage())
    return
  }
  const result = command === 'catalog'
    ? await publishCatalog(values)
    : await publishCore(values)
  console.log(JSON.stringify(result, null, 2))
}

main().catch(error => {
  console.error(`publish failed [${error?.code ?? 'error'}]: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
