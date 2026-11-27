import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import {
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function sha256File(path) {
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    createReadStream(path)
      .on('data', chunk => hash.update(chunk))
      .on('error', reject)
      .on('end', resolve)
  })
  return hash.digest('hex')
}

export async function readJson(path, fallback = undefined) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw error
  }
}

export async function atomicWriteJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = join(dirname(path), `.${process.pid}-${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
  await rename(temporary, path)
  try {
    const directory = await open(dirname(path), 'r')
    try { await directory.sync() } finally { await directory.close() }
  } catch {
    // Directory fsync is unavailable on some Windows filesystems.
  }
}

export async function pathBytes(path) {
  const info = await stat(path)
  return { bytes: info.size, sha256: await sha256File(path) }
}

export async function removeQuietly(path) {
  await rm(path, { recursive: true, force: true }).catch(() => undefined)
}
