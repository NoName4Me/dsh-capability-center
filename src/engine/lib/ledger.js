import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteJson, readJson } from './atomic.js'
import { CapabilityError } from './manifest.js'

function emptyLedger() {
  return {
    schemaVersion: 1,
    revision: 0,
    entries: {},
    migrationTombstones: {},
    updatedAt: new Date().toISOString(),
  }
}

export class LocalLedger {
  constructor(dataRoot) {
    this.dataRoot = dataRoot
    this.path = join(dataRoot, 'data', 'ledger.json')
    this.journalRoot = join(dataRoot, 'operations')
    this.value = emptyLedger()
  }

  async open() {
    await mkdir(this.journalRoot, { recursive: true })
    const loaded = await readJson(this.path, emptyLedger())
    if (loaded?.schemaVersion !== 1 || typeof loaded.entries !== 'object' || loaded.entries === null) {
      throw new CapabilityError('invalid-ledger', '本机安装账本格式无效，已停止自动修改。')
    }
    if (loaded.migrationTombstones === undefined) {
      loaded.migrationTombstones = {}
    } else if (typeof loaded.migrationTombstones !== 'object'
      || loaded.migrationTombstones === null
      || Array.isArray(loaded.migrationTombstones)) {
      throw new CapabilityError('invalid-ledger', '本机安装账本迁移记录格式无效，已停止自动修改。')
    }
    this.value = loaded
    return this
  }

  get(id) {
    return Object.hasOwn(this.value.entries, id) ? this.value.entries[id] : undefined
  }

  list() {
    return Object.values(this.value.entries)
  }

  hasMigrationTombstone(id) {
    return Object.hasOwn(this.value.migrationTombstones, id)
  }

  markMigrationTombstone(id, details = {}) {
    this.value.migrationTombstones[id] = {
      id,
      reason: 'uninstalled',
      ...details,
      at: new Date().toISOString(),
    }
  }

  async write() {
    this.value = {
      ...this.value,
      revision: Number(this.value.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    }
    await atomicWriteJson(this.path, this.value)
  }

  snapshot() {
    return structuredClone(this.value)
  }

  restore(snapshot) {
    this.value = structuredClone(snapshot)
  }

  async setEntry(entry, { write = true } = {}) {
    this.value.entries[entry.id] = structuredClone(entry)
    if (write) await this.write()
  }

  async removeEntry(id, { write = true } = {}) {
    delete this.value.entries[id]
    if (write) await this.write()
  }

  async begin({ operationId, action, itemId, beforeVersion, targetVersion, rollback = null }) {
    const id = operationId ?? randomUUID()
    const journal = {
      schemaVersion: 1,
      operationId: id,
      action,
      itemId,
      beforeVersion: beforeVersion ?? null,
      targetVersion: targetVersion ?? null,
      phase: 'prepared',
      beforeLedger: this.snapshot(),
      rollback,
      steps: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    await atomicWriteJson(this.journalPath(id), journal)
    return journal
  }

  journalPath(id) {
    return join(this.journalRoot, `${id}.json`)
  }

  async updateJournal(id, patch) {
    const journal = await readJson(this.journalPath(id))
    if (journal === undefined) throw new CapabilityError('journal-missing', '安装操作日志已丢失，停止自动修改。')
    const next = { ...journal, ...patch, updatedAt: new Date().toISOString() }
    await atomicWriteJson(this.journalPath(id), next)
    return next
  }

  async addStep(id, step) {
    const journal = await readJson(this.journalPath(id))
    if (journal === undefined) throw new CapabilityError('journal-missing', '安装操作日志已丢失，停止自动修改。')
    return await this.updateJournal(id, {
      steps: [...(journal.steps ?? []), { ...step, at: new Date().toISOString() }],
    })
  }

  async appendIntent(id, intent) {
    const journal = await readJson(this.journalPath(id))
    if (journal === undefined) throw new CapabilityError('journal-missing', '安装操作日志已丢失，停止自动修改。')
    const intents = [...(journal.intents ?? []), { ...intent, at: new Date().toISOString() }]
    await this.updateJournal(id, { intents })
    return intents
  }

  async commit(id) {
    // Persist the new ledger first. A crash before the journal is marked
    // committed therefore remains recoverable by restoring beforeLedger and
    // reversing every persisted intent.
    await this.write()
    await this.updateJournal(id, { phase: 'committed' })
    await rm(this.journalPath(id), { force: true })
  }

  async close(id) {
    await rm(this.journalPath(id), { force: true })
  }

  async pending() {
    let names
    try {
      names = await readdir(this.journalRoot)
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const values = []
    for (const name of names.filter(name => name.endsWith('.json'))) {
      try {
        values.push(JSON.parse(await readFile(join(this.journalRoot, name), 'utf8')))
      } catch {
        values.push({
          operationId: name.slice(0, -5),
          phase: 'unreadable',
          recoveryRequired: true,
        })
      }
    }
    return values
  }
}
