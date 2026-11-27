import { createHash, randomUUID } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
  open,
} from 'node:fs/promises'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { readZip, safeRelativePath } from './archive.js'
import { CapabilityError } from './manifest.js'

const SHA256 = /^[a-f0-9]{64}$/u

export function hashBytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

function fileRecords(files, prefix = '') {
  return [...files]
    .filter(([path]) => !path.endsWith('/') && path.startsWith(prefix))
    .map(([path, bytes]) => ({
      path: path.slice(prefix.length),
      bytes: bytes.byteLength,
      sha256: hashBytes(bytes),
    }))
    .sort((left, right) => left.path.localeCompare(right.path))
}

async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${process.pid}-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(bytes)
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
}

export async function downloadArtifact(item, dataRoot, http, { maxBytes = 32 * 1024 * 1024 } = {}) {
  if (item.artifact === undefined) return undefined
  const directory = join(dataRoot, 'artifacts', item.id, item.version)
  const target = join(directory, basename(new URL(item.artifact.url).pathname))
  try {
    const existing = await readFile(target)
    if (existing.byteLength === item.artifact.bytes && hashBytes(existing) === item.artifact.sha256) {
      return target
    }
    await rm(target, { force: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  let response
  try {
    response = await http.readBoundedUrl(item.artifact.url, {
      timeoutMs: 60_000,
      maxBytes,
      headers: { accept: 'application/octet-stream' },
    })
  } catch (error) {
    throw new CapabilityError('download-failed', `下载 ${item.name} 失败：${messageOf(error)}`)
  }
  const bytes = response.body
  if (bytes.byteLength !== item.artifact.bytes || hashBytes(bytes) !== item.artifact.sha256) {
    throw new CapabilityError('hash-mismatch', `${item.name} 的字节数或 SHA-256 不匹配。`)
  }
  await atomicWrite(target, bytes)
  return target
}

function validateSkillFiles(files, item) {
  const prefix = `${item.id}/`
  const skill = files.get(`${prefix}SKILL.md`)
  if (skill === undefined) throw new CapabilityError('invalid-skill', '技能包缺少固定目录下的 SKILL.md。')
  for (const [name, bytes] of files) {
    if (!name.startsWith(prefix)) {
      throw new CapabilityError('unsafe-archive', `技能包包含固定目录之外的路径：${name}`)
    }
    if (bytes.byteLength > 2 * 1024 * 1024) throw new CapabilityError('invalid-skill', `技能文件过大：${name}`)
  }
  const text = skill.toString('utf8')
  const escaped = item.id.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  if (!new RegExp(`^---\\r?\\n[\\s\\S]*?name:\\s*${escaped}\\r?\\n[\\s\\S]*?description:\\s*.+\\r?\\n[\\s\\S]*?---`, 'u').test(text)) {
    throw new CapabilityError('invalid-skill', `SKILL.md 的 name 必须为 ${item.id}，且必须包含 description。`)
  }
  return prefix
}

async function moveAcrossDevices(source, target) {
  try {
    await rename(source, target)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await cp(source, target, { recursive: true, errorOnExist: true, force: false })
    await rm(source, { recursive: true, force: true })
  }
}

export async function installSkill({
  item,
  bytes,
  dataRoot,
  dshHome,
  operationId,
  beforeMutation = async () => undefined,
  afterMutation = async () => undefined,
}) {
  const files = readZip(bytes)
  const prefix = validateSkillFiles(files, item)
  const runtimeRoot = join(dataRoot, 'capability-files', item.id, 'releases', item.version)
  const stage = join(dataRoot, 'capability-files', item.id, `.stage-${operationId}`)
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  for (const [name, content] of files) {
    const relative = name.slice(prefix.length)
    if (!safeRelativePath(relative)) throw new CapabilityError('unsafe-path', `技能路径不安全：${relative}`)
    const output = resolve(stage, ...relative.split('/'))
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, content, { flag: 'wx' })
  }
  const target = join(dshHome, 'skills', item.id)
  const backup = join(dataRoot, 'rollback', operationId, 'skill', item.id)
  await mkdir(dirname(target), { recursive: true })
  await mkdir(dirname(backup), { recursive: true })
  let hadPrevious = false
  try {
    const info = await lstat(target)
    hadPrevious = info.isDirectory() && !info.isSymbolicLink()
    if (!hadPrevious) throw new CapabilityError('unsafe-path', '现有技能目标不是普通目录，拒绝覆盖。')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  // The intent is durable before touching the live DSH skill directory.
  // Stage construction is isolated and can be discarded safely on failure.
  const rollback = { kind: 'skill', target, backup, hadPrevious, runtimeRoot }
  await beforeMutation(rollback)
  let movedOld = false
  try {
    if (hadPrevious) {
      await moveAcrossDevices(target, backup)
      movedOld = true
    }
    await moveAcrossDevices(stage, target)
    await afterMutation(rollback)
  } catch (error) {
    if (movedOld) await moveAcrossDevices(backup, target).catch(() => undefined)
    throw new CapabilityError('skill-install-failed', `技能写入失败：${messageOf(error)}`)
  }
  return {
    runtimeRoot: target,
    recordRoot: target,
    ownedFiles: fileRecords(files, prefix),
    rollback,
  }
}

export async function rollbackSkill(record) {
  if (record === null || record === undefined) return
  let backupPresent = false
  try {
    const info = await lstat(record.backup)
    backupPresent = info.isDirectory()
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (backupPresent) {
    await rm(record.target, { recursive: true, force: true })
    await mkdir(dirname(record.target), { recursive: true })
    await moveAcrossDevices(record.backup, record.target)
  } else if (record.hadPrevious !== true) {
    await rm(record.target, { recursive: true, force: true })
  }
}

export async function rollbackSkillUninstall(record) {
  if (record === null || record === undefined) return
  let removedPresent = false
  try {
    const info = await lstat(record.removed)
    removedPresent = info.isDirectory()
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (!removedPresent) return
  await rm(record.target, { recursive: true, force: true })
  await mkdir(dirname(record.target), { recursive: true })
  await moveAcrossDevices(record.removed, record.target)
}

async function assertNoSymlinkPath(root, relative) {
  const absoluteRoot = resolve(root)
  const rootInfo = await lstat(absoluteRoot)
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    throw new CapabilityError('unsafe-path', '受管根目录不是普通目录。')
  }
  let current = absoluteRoot
  for (const part of relative.split('/')) {
    current = join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new CapabilityError('unsafe-path', `受管路径包含符号链接：${relative}`)
  }
}

export async function verifyOwnedFiles(root, records) {
  for (const record of records) {
    if (!safeRelativePath(record.path) || !SHA256.test(record.sha256)
      || !Number.isSafeInteger(record.bytes) || record.bytes < 0) {
      throw new CapabilityError('invalid-ledger', '账本中的文件记录无效。')
    }
    await assertNoSymlinkPath(root, record.path)
    const path = resolve(root, ...record.path.split('/'))
    let info
    try {
      info = await lstat(path)
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new CapabilityError('owned-files-changed', `受管文件缺失：${record.path}`)
      }
      throw error
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new CapabilityError('owned-files-changed', `受管路径不是普通文件：${record.path}`)
    }
    const bytes = await readFile(path)
    if (bytes.byteLength !== record.bytes || hashBytes(bytes) !== record.sha256) {
      throw new CapabilityError('owned-files-changed', `受管文件已被修改，已保留现场：${record.path}`)
    }
  }
}

export async function removeOwnedTree({
  root,
  records,
  dataRoot,
  itemId,
  operationId,
}) {
  await verifyOwnedFiles(root, records)
  const removed = join(dataRoot, 'removed', `${itemId}-${operationId}`)
  await mkdir(dirname(removed), { recursive: true })
  await moveAcrossDevices(root, removed)
  return removed
}

export async function moveVerifiedFiles({
  root,
  records,
  dataRoot,
  itemId,
  operationId,
}) {
  await verifyOwnedFiles(root, records)
  const removed = join(dataRoot, 'removed', `${itemId}-${operationId}`)
  await mkdir(removed, { recursive: true })
  const moved = []
  try {
    for (const record of records) {
      const source = resolve(root, ...record.path.split('/'))
      const destination = resolve(removed, ...record.path.split('/'))
      await mkdir(dirname(destination), { recursive: true })
      await rename(source, destination)
      moved.push({ source, destination })
    }
  } catch (error) {
    for (const record of moved.reverse()) {
      await mkdir(dirname(record.source), { recursive: true })
      await rename(record.destination, record.source).catch(() => undefined)
    }
    await rm(removed, { recursive: true, force: true }).catch(() => undefined)
    throw new CapabilityError('uninstall-failed', `受管文件移动失败：${messageOf(error)}`)
  }
  const directories = [...new Set(records.map(record => dirname(resolve(root, ...record.path.split('/')))))]
    .sort((left, right) => right.length - left.length)
  for (const directory of directories) {
    let current = directory
    while (current.startsWith(resolve(root) + sep)) {
      try { await rmdir(current) } catch { break }
      current = dirname(current)
    }
  }
  return removed
}

function inspectWheel(files, item) {
  if ([...files.keys()].some(name => name.split('/')[0].endsWith('.data'))) {
    throw new CapabilityError('unsupported-wheel', '离线安装器不支持 wheel 的 .data 安装方案。')
  }
  const distInfo = `${item.install.distribution}-${item.version}.dist-info`
  const wheel = files.get(`${distInfo}/WHEEL`)
  const metadata = files.get(`${distInfo}/METADATA`)
  const record = files.get(`${distInfo}/RECORD`)
  if (wheel === undefined || metadata === undefined || record === undefined) {
    throw new CapabilityError('invalid-wheel', 'wheel 缺少 WHEEL、METADATA 或 RECORD。')
  }
  if (!/^Root-Is-Purelib:\s*true$/imu.test(wheel.toString('utf8'))
    || !/^Tag:\s*py3-none-any$/imu.test(wheel.toString('utf8'))) {
    throw new CapabilityError('unsupported-wheel', '仅支持 Root-Is-Purelib: true 的 py3-none-any wheel。')
  }
  const metadataText = metadata.toString('utf8')
  const distribution = item.install.distribution.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  const version = item.version.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
  if (!new RegExp(`^Name:\\s*${distribution}\\s*$`, 'imu').test(metadataText)
    || !new RegExp(`^Version:\\s*${version}\\s*$`, 'imu').test(metadataText)) {
    throw new CapabilityError('invalid-wheel', 'wheel 元数据名称或版本与目录不一致。')
  }
  const listed = new Set()
  for (const line of record.toString('utf8').split(/\r?\n/u)) {
    if (!line) continue
    const comma = line.indexOf(',')
    const path = comma < 0 ? line : line.slice(0, comma)
    if (!safeRelativePath(path) || listed.has(path) || !files.has(path)) {
      throw new CapabilityError('invalid-wheel', `wheel RECORD 路径无效：${path}`)
    }
    listed.add(path)
    const encoded = line.slice(comma + 1).split(',', 1)[0]
    if (encoded) {
      const match = /^sha256=([A-Za-z0-9_-]{43})$/u.exec(encoded)
      if (match === null || Buffer.from(match[1], 'base64url').toString('hex') !== hashBytes(files.get(path))) {
        throw new CapabilityError('invalid-wheel', `wheel RECORD 哈希不匹配：${path}`)
      }
    } else if (path !== `${distInfo}/RECORD`) {
      throw new CapabilityError('invalid-wheel', `wheel RECORD 缺少哈希：${path}`)
    }
  }
  if (listed.size !== files.size) throw new CapabilityError('invalid-wheel', 'wheel 包含未列入 RECORD 的文件。')
  return files
}

export async function installPython({
  item,
  bytes,
  dataRoot,
  pythonPackages,
  operationId,
  beforeMutation = async () => undefined,
  afterMutation = async () => undefined,
}) {
  const files = inspectWheel(readZip(bytes), item)
  const runtimeRoot = join(dataRoot, 'python', item.id, 'releases', item.version, 'site')
  const stage = join(dataRoot, 'python', item.id, `.stage-${operationId}`)
  await rm(stage, { recursive: true, force: true })
  await mkdir(stage, { recursive: true })
  for (const [name, content] of files) {
    const output = resolve(stage, ...name.split('/'))
    if (!output.startsWith(resolve(stage) + sep)) throw new CapabilityError('unsafe-path', `wheel 路径越界：${name}`)
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, content, { flag: 'wx' })
  }
  const pth = join(pythonPackages, `capability-center-${item.id}.pth`)
  let previousPth
  let hadPreviousRuntime = false
  try { previousPth = await readFile(pth, 'utf8') } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  try {
    const info = await lstat(runtimeRoot)
    hadPreviousRuntime = info.isDirectory() && !info.isSymbolicLink()
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const runtimeBackup = join(dataRoot, 'rollback', operationId, 'python', item.id, item.version)
  const rollbackIntent = {
    kind: 'python',
    pth,
    previousPth,
    runtimeRoot,
    runtimeBackup,
    hadPreviousRuntime,
  }
  await beforeMutation(rollbackIntent)
  try {
    await mkdir(dirname(runtimeBackup), { recursive: true })
    if (hadPreviousRuntime) await moveAcrossDevices(runtimeRoot, runtimeBackup)
    await mkdir(dirname(runtimeRoot), { recursive: true })
    await rename(stage, runtimeRoot)
    await atomicWrite(pth, Buffer.from(`${runtimeRoot}\n`, 'utf8'))
    await afterMutation(rollbackIntent)
  } catch (error) {
    await rm(stage, { recursive: true, force: true }).catch(() => undefined)
    throw new CapabilityError('python-install-failed', `Python 库写入失败：${messageOf(error)}`)
  }
  return {
    runtimeRoot,
    pythonPackages,
    pth,
    previousPth,
    ownedFiles: fileRecords(files),
    rollback: rollbackIntent,
  }
}

export async function rollbackPython(record) {
  if (record === null || record === undefined) return
  if (record.previousPth === undefined) await rm(record.pth, { force: true })
  else await atomicWrite(record.pth, Buffer.from(record.previousPth, 'utf8'))
  let backupPresent = false
  try {
    const info = await lstat(record.runtimeBackup)
    backupPresent = info.isDirectory()
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (backupPresent) {
    await rm(record.runtimeRoot, { recursive: true, force: true })
    await mkdir(dirname(record.runtimeRoot), { recursive: true })
    await moveAcrossDevices(record.runtimeBackup, record.runtimeRoot)
  } else if (record.hadPreviousRuntime !== true) {
    await rm(record.runtimeRoot, { recursive: true, force: true })
  }
}

export async function rollbackPythonUninstall(record) {
  if (record === null || record === undefined) return
  if (record.previousPth !== undefined) {
    await atomicWrite(record.pth, Buffer.from(record.previousPth, 'utf8'))
  }
  let removedPresent = false
  try {
    const info = await lstat(record.removed)
    removedPresent = info.isDirectory()
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  if (removedPresent) {
    await rm(record.runtimeRoot, { recursive: true, force: true })
    await mkdir(dirname(record.runtimeRoot), { recursive: true })
    await moveAcrossDevices(record.removed, record.runtimeRoot)
  }
}

export async function rollbackLegacyPythonUninstall(record) {
  if (record === null || record === undefined) return
  for (const relative of record.records) {
    const source = resolve(record.removed, ...relative.split('/'))
    const target = resolve(record.root, ...relative.split('/'))
    try {
      await lstat(source)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    await mkdir(dirname(target), { recursive: true })
    await rename(source, target)
  }
  await rm(record.removed, { recursive: true, force: true })
}

export async function uninstallPython({ item, entry, dataRoot, pythonPackages, operationId }) {
  if (entry.legacy === true) {
    throw new CapabilityError(
      'legacy-uninstall-required',
      '该 Python 安装来自旧版逐文件回执，请先在设置→插件中升级能力中心后再次检查，系统将按旧回执安全迁移。',
    )
  }
  if (resolve(entry.pythonPackages) !== resolve(pythonPackages)) {
    throw new CapabilityError('runtime-mismatch', '当前 DSH Python 与安装账本记录不一致，已保留文件。')
  }
  const pth = join(pythonPackages, `capability-center-${item.id}.pth`)
  const content = await readFile(pth, 'utf8')
  if (content.trim() !== entry.runtimeRoot) {
    throw new CapabilityError('owned-files-changed', '.pth 已不是能力中心写出的版本，已保留现场。')
  }
  const removed = join(dataRoot, 'removed', `${item.id}-${operationId}`)
  await mkdir(dirname(removed), { recursive: true })
  await rename(entry.runtimeRoot, removed)
  await rm(pth, { force: true })
  return removed
}

export async function collectDirectoryFiles(root, prefix = '') {
  const records = []
  async function visit(directory, relative) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      if (entry.isSymbolicLink()) throw new CapabilityError('unsafe-path', `目录包含符号链接：${path}`)
      if (entry.isDirectory()) {
        await visit(join(directory, entry.name), path)
      } else if (entry.isFile()) {
        const bytes = await readFile(join(directory, entry.name))
        records.push({ path: `${prefix}${path}`, bytes: bytes.byteLength, sha256: hashBytes(bytes) })
      }
    }
  }
  await visit(root, '')
  return records
}
