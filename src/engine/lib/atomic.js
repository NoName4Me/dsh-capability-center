import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'

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
    // Directory fsync is not supported on every Windows volume.
  }
}
