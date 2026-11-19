import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { acquireLock, releaseLock } from '../tools/dev.mjs'

test('dev lock replaces a lock left by a dead process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capability-center-dev-lock-'))
  const path = join(directory, 'dev.lock')
  try {
    await writeFile(path, `${JSON.stringify({ pid: 999_999_999, startedAt: new Date().toISOString() })}\n`)
    const result = acquireLock(path, process.pid)
    assert.equal(result.recoveredPid, 999_999_999)
    assert.equal(JSON.parse(await readFile(path, 'utf8')).pid, process.pid)
    releaseLock(path, process.pid)
    await assert.rejects(readFile(path, 'utf8'), error => error?.code === 'ENOENT')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('dev lock remains held by a running process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capability-center-dev-lock-'))
  const path = join(directory, 'dev.lock')
  try {
    await writeFile(path, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`)
    assert.throws(
      () => acquireLock(path, process.pid),
      new RegExp(`npm run dev 已在运行（PID ${process.pid}）`, 'u'),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('dev lock release never removes a lock owned by another process', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'capability-center-dev-lock-'))
  const path = join(directory, 'dev.lock')
  try {
    const content = `${JSON.stringify({ pid: process.ppid, startedAt: new Date().toISOString() })}\n`
    await writeFile(path, content)
    releaseLock(path, process.pid)
    assert.equal(await readFile(path, 'utf8'), content)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
