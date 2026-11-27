import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { Writable } from 'node:stream'
import {
  access,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { test } from 'node:test'
import {
  EngineSupervisor,
  normalizeDevDistributionUrl,
} from '../apps/dsh-plugin/bootstrap/lib/supervisor.js'
import { readZip } from '../apps/dsh-plugin/core/lib/archive.js'
import { readBoundedUrl } from '../apps/dsh-plugin/bootstrap/lib/http-transport.js'
import {
  createZip,
  dist,
  fakeContext,
  sha256,
  startFileServer,
  tempRoot,
} from './helpers.js'

const node = process.execPath

function coreManifest(version) {
  return {
    schemaVersion: 1,
    name: 'capability-center-core',
    version,
    protocolVersion: 1,
    entry: 'engine/index.js',
    compatibility: {
      dsh: '0.2.1-rc.2',
      os: ['win32', 'darwin', 'linux'],
      arch: ['x64', 'arm64'],
    },
  }
}

function engineSource(version, mode = 'ok') {
  if (mode === 'exit') {
    return `process.exit(37)\n`
  }
  if (mode === 'boot-attempt-fail') {
    return `import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function apply(ctx, config) {
  const state = JSON.parse(await readFile(
    join(process.env.DSH_HOME, 'capability-center', 'engine-state.json'),
    'utf8',
  ))
  if (state.bootAttempt?.version !== config.runtime.version) {
    throw new Error('hot candidate started before bootAttempt was persisted')
  }
  throw new Error('candidate failed after bootAttempt check')
}
`
  }
  return `export async function apply(ctx, config) {
  if (${JSON.stringify(mode)} === 'fail') throw new Error('candidate failed')
  config.runtime.setEngine({
    version: config.runtime.version,
    async handle() { return false },
    verify() {
      return ${JSON.stringify(mode)} === 'verify-fail'
        ? { ready: false, version: config.runtime.version }
        : { ready: true, version: config.runtime.version }
    },
    stopAcceptingWork() {},
    async drain() {},
    async dispose() {},
  })
  ctx.effect(() => () => undefined, 'fixture engine')
}
`
}

async function writeCoreDirectory(directory, version, mode = 'ok') {
  await mkdir(join(directory, 'engine'), { recursive: true })
  await mkdir(join(directory, 'page'), { recursive: true })
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(coreManifest(version)))
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: 'capability-center-core',
    version,
    private: true,
    type: 'module',
  }))
  await writeFile(join(directory, 'engine', 'index.js'), engineSource(version, mode))
  await writeFile(join(directory, 'page', 'index.html'), '<!doctype html><title>fixture</title>')
  await writeFile(join(directory, 'page', 'app.js'), '')
  await writeFile(join(directory, 'page', 'styles.css'), '')
}

async function makeCoreZip(path, version, mode = 'ok') {
  const entries = {
    'manifest.json': `${JSON.stringify(coreManifest(version), null, 2)}\n`,
    'package.json': `${JSON.stringify({
      name: 'capability-center-core',
      version,
      private: true,
      type: 'module',
    }, null, 2)}\n`,
    'engine/index.js': engineSource(version, mode),
    'page/index.html': '<!doctype html><title>fixture</title>',
    'page/app.js': '',
    'page/styles.css': '',
  }
  await createZip(path, entries)
  return await readFile(path)
}

function supervisorContext({ syncDispose = false } = {}) {
  const disposed = []
  const ctx = {
    disposed,
    logger: { warn() {} },
    plugin(plugin, config) {
      let disposers = []
      let disposedFlag = false
      const child = Object.create(ctx)
      child.effect = callback => {
        const disposer = callback()
        disposers.push(disposer)
        return disposer
      }
      const dispose = async () => {
        for (const disposer of disposers.reverse()) await disposer?.()
        disposers = []
        disposedFlag = true
        disposed.push(config.runtime.version)
      }
      const fiber = {
        async await() {
          await plugin.apply(child, config)
          return fiber
        },
        dispose: syncDispose
          ? () => {
              for (const disposer of disposers.reverse()) disposer?.()
              disposers = []
              disposedFlag = true
              disposed.push(config.runtime.version)
            }
          : dispose,
        get disposed() {
          return disposedFlag
        },
      }
      return fiber
    },
  }
  return ctx
}

async function seedPackageRoot(temp) {
  const packageRoot = join(temp, 'bootstrap')
  await writeCoreDirectory(join(packageRoot, 'engine-seed'), '0.2.0')
  return packageRoot
}

test('manual host restart is restricted to local requests on a host with native restart support', async () => {
  const temp = await tempRoot('capability-center-host-restart-')
  try {
    await withHome(join(temp, 'home'), async () => {
      const context = supervisorContext()
      const supervisor = new EngineSupervisor(context, { packageRoot: await seedPackageRoot(temp) })
      try {
        await supervisor.ready
        const route = '/api/host/restart'
        const request = async (remoteAddress, confirm = true) => {
          const response = new Writable({ write(_chunk, _encoding, done) { done() } })
          response.setHeader = () => {}
          const handled = await supervisor.handle({
            method: 'POST',
            socket: { remoteAddress },
            headers: { 'content-type': 'application/json' },
            async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ confirm })) },
          }, response, route, new URL(route, 'http://localhost'))
          assert.equal(handled, true)
          return response.statusCode
        }
        assert.equal(await request('127.0.0.1'), 501)
        let restarted
        const called = new Promise(resolve => { restarted = resolve })
        context.get = key => key === 'desktopActions' ? { requestRestart: restarted } : undefined
        assert.equal(await request('192.0.2.1'), 403)
        assert.equal(await request('127.0.0.1', false), 400)
        supervisor.engine.hasPendingActions = () => true
        assert.equal(await request('127.0.0.1'), 409)
        supervisor.engine.hasPendingActions = () => false
        assert.equal(await request('127.0.0.1'), 202)
        const timeout = setTimeout(() => restarted('timed out'), 1500)
        try {
          assert.equal(await called, undefined)
        } finally {
          clearTimeout(timeout)
        }
      } finally {
        await supervisor.dispose()
      }
    })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

function releaseIndex(releases) {
  return {
    schemaVersion: 1,
    name: 'fixture core releases',
    protocolVersion: 1,
    targetDsh: 'dsh-v0.2.1-rc.2',
    releases: releases.map(release => ({
      version: release.version,
      archive: `core/capability-center-core-${release.version}.zip`,
      sha256: sha256(release.bytes),
      bytes: release.bytes.byteLength,
      compatibility: coreManifest(release.version).compatibility,
    })),
  }
}

async function withHome(home, callback) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await callback()
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
}

test('core stage activates on next startup and a failed candidate falls back to previous good core', async () => {
  const temp = await tempRoot('capability-center-core-restart-')
  const home = join(temp, 'home')
  const packageRoot = await seedPackageRoot(temp)
  const good = await makeCoreZip(join(temp, 'good.zip'), '0.2.1')
  const bad = await makeCoreZip(join(temp, 'bad.zip'), '0.2.2', 'fail')
  const server = await startFileServer(new Map([
    ['/core/capability-center-core-0.2.1.zip', good],
    ['/core/capability-center-core-0.2.2.zip', bad],
  ]))
  try {
    await withHome(home, async () => {
      server.routes.set('/core-release-index.json', Buffer.from(JSON.stringify(
        releaseIndex([{ version: '0.2.1', bytes: good }]),
      )))
      const first = new EngineSupervisor(supervisorContext(), { packageRoot })
      const initial = await first.ready
      assert.equal(initial.ready, true)
      assert.equal(first.engine.version, '0.2.0')
      const staged = await first.stage(server.base)
      assert.equal(staged.version, '0.2.1')
      assert.equal((await first.state()).pending.version, '0.2.1')
      assert.equal(first.engine.version, '0.2.0')
      await first.dispose()

      const second = new EngineSupervisor(supervisorContext(), { packageRoot })
      const activated = await second.ready
      assert.equal(activated.ready, true)
      assert.equal(activated.current.version, '0.2.1')
      assert.equal(activated.previous.version, '0.2.0')
      assert.equal(second.engine.version, '0.2.1')

      server.routes.set('/core-release-index.json', Buffer.from(JSON.stringify(
        releaseIndex([{ version: '0.2.2', bytes: bad }, { version: '0.2.1', bytes: good }]),
      )))
      await second.stage(server.base)
      assert.equal((await second.state()).pending.version, '0.2.2')
      await second.dispose()

      const third = new EngineSupervisor(supervisorContext(), { packageRoot })
      const recovered = await third.ready
      assert.equal(recovered.ready, true)
      assert.equal(recovered.current.version, '0.2.1')
      assert.equal(recovered.pending, null)
      assert.equal(recovered.lastFailure.version, '0.2.2')
      assert.equal(third.engine.version, '0.2.1')
      await assert.rejects(
        access(join(home, 'capability-center', 'releases', '0.2.2')),
        error => error.code === 'ENOENT',
      )
      await third.dispose()
    })
  } finally {
    await server.close()
    await rm(temp, { recursive: true, force: true })
  }
})

test('core staging writes its marker before commit and refuses immutable version conflicts', async () => {
  const temp = await tempRoot('capability-center-core-immutable-')
  const home = join(temp, 'home')
  const packageRoot = await seedPackageRoot(temp)
  const firstBytes = await makeCoreZip(join(temp, 'first-0.2.1.zip'), '0.2.1')
  const secondBytes = await makeCoreZip(join(temp, 'second-0.2.1.zip'), '0.2.1', 'fail')
  const candidateBytes = await makeCoreZip(join(temp, 'candidate-0.2.2.zip'), '0.2.2')
  const server = await startFileServer(new Map([
    ['/core/capability-center-core-0.2.1.zip', firstBytes],
    ['/core/capability-center-core-0.2.2.zip', candidateBytes],
  ]))
  try {
    await withHome(home, async () => {
      server.routes.set('/core-release-index.json', Buffer.from(JSON.stringify(
        releaseIndex([{ version: '0.2.1', bytes: firstBytes }]),
      )))
      const supervisor = new EngineSupervisor(supervisorContext(), { packageRoot })
      await supervisor.ready
      await supervisor.stage(server.base)
      const marker = JSON.parse(await readFile(
        join(home, 'capability-center', 'releases', '0.2.1', '.archive.json'),
        'utf8',
      ))
      assert.equal(marker.sha256, sha256(firstBytes))

      const conflicting = join(home, 'capability-center', 'releases', '0.2.2')
      await writeCoreDirectory(conflicting, '0.2.2')
      await writeFile(join(conflicting, '.archive.json'), JSON.stringify({
        version: '0.2.2',
        sha256: sha256(secondBytes),
        bytes: secondBytes.byteLength,
      }))
      server.routes.set('/core-release-index.json', Buffer.from(JSON.stringify(
        releaseIndex([{ version: '0.2.2', bytes: candidateBytes }]),
      )))
      await assert.rejects(
        supervisor.stage(server.base),
        error => error.code === 'release-immutable-conflict',
      )
      const state = await supervisor.state()
      assert.equal(state.pending.version, '0.2.1')
      assert.equal(
        JSON.parse(await readFile(join(conflicting, '.archive.json'), 'utf8')).sha256,
        sha256(secondBytes),
      )
      await supervisor.dispose()
    })
  } finally {
    await server.close()
    await rm(temp, { recursive: true, force: true })
  }
})

test('hot core activation drains, verifies and atomically replaces the running core', async () => {
  const temp = await tempRoot('capability-center-core-hot-activate-')
  const home = join(temp, 'home')
  const packageRoot = await seedPackageRoot(temp)
  const candidateBytes = await makeCoreZip(join(temp, 'candidate.zip'), '0.2.1')
  const server = await startFileServer(new Map([
    ['/core-release-index.json', Buffer.from(JSON.stringify(
      releaseIndex([{ version: '0.2.1', bytes: candidateBytes }]),
    ))],
    ['/core/capability-center-core-0.2.1.zip', candidateBytes],
  ]))
  try {
    await withHome(home, async () => {
      const context = supervisorContext()
      const supervisor = new EngineSupervisor(context, { packageRoot })
      await supervisor.ready
      await supervisor.stage(server.base)
      const activated = await supervisor.activatePending()
      assert.equal(activated.activated, true)
      assert.equal(activated.activeVersion, '0.2.1')
      assert.equal(supervisor.engine.version, '0.2.1')
      assert.deepEqual(context.disposed, ['0.2.0'])
      const state = await supervisor.state()
      assert.equal(state.current.version, '0.2.1')
      assert.equal(state.previous.version, '0.2.0')
      assert.equal(state.pending, null)
      assert.equal(state.bootAttempt, null)
      await supervisor.dispose()
      assert.deepEqual(context.disposed, ['0.2.0', '0.2.1'])
    })
  } finally {
    await server.close()
    await rm(temp, { recursive: true, force: true })
  }
})

test('hot activation persists bootAttempt, tolerates sync dispose, isolates failure and rolls back', async () => {
  const temp = await tempRoot('capability-center-core-hot-rollback-')
  const home = join(temp, 'home')
  const packageRoot = await seedPackageRoot(temp)
  const candidateBytes = await makeCoreZip(
    join(temp, 'candidate.zip'),
    '0.2.1',
    'boot-attempt-fail',
  )
  const server = await startFileServer(new Map([
    ['/core-release-index.json', Buffer.from(JSON.stringify(
      releaseIndex([{ version: '0.2.1', bytes: candidateBytes }]),
    ))],
    ['/core/capability-center-core-0.2.1.zip', candidateBytes],
  ]))
  try {
    await withHome(home, async () => {
      const context = supervisorContext({ syncDispose: true })
      const supervisor = new EngineSupervisor(context, { packageRoot })
      await supervisor.ready
      await supervisor.stage(server.base)
      await assert.rejects(
        supervisor.activatePending(),
        error => error?.code === 'core-activation-failed'
          && error.rolledBack === true
          && /bootAttempt/u.test(error.message),
      )
      assert.equal(supervisor.engine.version, '0.2.0')
      assert.deepEqual(context.disposed, ['0.2.0', '0.2.1'])
      const state = await supervisor.state()
      assert.equal(state.current.version, '0.2.0')
      assert.equal(state.pending, null)
      assert.equal(state.bootAttempt, null)
      assert.equal(state.lastFailure.version, '0.2.1')
      await assert.rejects(
        access(join(home, 'capability-center', 'releases', '0.2.1')),
        error => error.code === 'ENOENT',
      )
      await supervisor.dispose()
      assert.deepEqual(context.disposed, ['0.2.0', '0.2.1', '0.2.0'])
    })
  } finally {
    await server.close()
    await rm(temp, { recursive: true, force: true })
  }
})

test('hot activation rejects a stale window version before touching the running core', async () => {
  const temp = await tempRoot('capability-center-core-hot-conflict-')
  const home = join(temp, 'home')
  const packageRoot = await seedPackageRoot(temp)
  const first = await makeCoreZip(join(temp, 'first.zip'), '0.2.1')
  const second = await makeCoreZip(join(temp, 'second.zip'), '0.2.2')
  const server = await startFileServer(new Map([
    ['/core/capability-center-core-0.2.1.zip', first],
    ['/core/capability-center-core-0.2.2.zip', second],
  ]))
  try {
    await withHome(home, async () => {
      server.routes.set('/core-release-index.json', Buffer.from(JSON.stringify(
        releaseIndex([{ version: '0.2.1', bytes: first }]),
      )))
      const context = supervisorContext()
      const supervisor = new EngineSupervisor(context, { packageRoot })
      await supervisor.ready
      await supervisor.stage(server.base)
      server.routes.set('/core-release-index.json', Buffer.from(JSON.stringify(
        releaseIndex([{ version: '0.2.2', bytes: second }]),
      )))
      await supervisor.stage(server.base)

      await assert.rejects(
        supervisor.activatePending('0.2.1'),
        error => error?.code === 'pending-core-changed'
          && error.status === 409
          && error.pendingVersion === '0.2.2',
      )
      assert.equal(supervisor.engine.version, '0.2.0')
      assert.deepEqual(context.disposed, [])
      assert.equal((await supervisor.state()).pending.version, '0.2.2')
      await supervisor.dispose()
    })
  } finally {
    await server.close()
    await rm(temp, { recursive: true, force: true })
  }
})

test('bootAttempt write failure leaves the current core untouched', async () => {
  const temp = await tempRoot('capability-center-core-boot-write-failure-')
  const home = join(temp, 'home')
  const packageRoot = await seedPackageRoot(temp)
  const candidateBytes = await makeCoreZip(join(temp, 'candidate.zip'), '0.2.1')
  const server = await startFileServer(new Map([
    ['/core-release-index.json', Buffer.from(JSON.stringify(
      releaseIndex([{ version: '0.2.1', bytes: candidateBytes }]),
    ))],
    ['/core/capability-center-core-0.2.1.zip', candidateBytes],
  ]))
  try {
    await withHome(home, async () => {
      const context = supervisorContext()
      const supervisor = new EngineSupervisor(context, { packageRoot })
      await supervisor.ready
      await supervisor.stage(server.base)
      const writeState = supervisor.writeState.bind(supervisor)
      supervisor.writeState = async state => {
        if (state.bootAttempt?.mode === 'hot-activation') {
          throw new Error('injected bootAttempt write failure')
        }
        return await writeState(state)
      }
      await assert.rejects(
        supervisor.activatePending('0.2.1'),
        /injected bootAttempt write failure/u,
      )
      assert.equal(supervisor.engine.version, '0.2.0')
      assert.deepEqual(context.disposed, [])
      assert.equal((await supervisor.state()).pending.version, '0.2.1')
      await supervisor.dispose()
    })
  } finally {
    await server.close()
    await rm(temp, { recursive: true, force: true })
  }
})

test('dev seed activation reads the bundled seed instead of a stale same-version release cache', async () => {
  const temp = await tempRoot('capability-center-core-dev-seed-')
  const home = join(temp, 'home')
  const packageRoot = await seedPackageRoot(temp)
  await writeCoreDirectory(
    join(home, 'capability-center', 'releases', '0.2.0'),
    '0.2.0',
    'fail',
  )
  try {
    await withHome(home, async () => {
      const supervisor = new EngineSupervisor(supervisorContext(), {
        packageRoot,
        devSeed: true,
        devDistributionUrl: undefined,
      })
      const status = await supervisor.ready
      assert.equal(status.ready, true)
      assert.equal(status.current.version, '0.2.0')
      assert.equal(status.current.source, 'dev-seed')
      assert.equal(supervisor.engine.version, '0.2.0')
      await supervisor.dispose()
    })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('dev seed automatically promotes a newer bundled core from its activation root', async () => {
  const temp = await tempRoot('capability-center-core-dev-seed-promote-')
  const home = join(temp, 'home')
  const packageRoot = await seedPackageRoot(temp)
  await writeCoreDirectory(
    join(home, 'capability-center', 'releases', '0.1.9'),
    '0.1.9',
  )
  await mkdir(join(home, 'capability-center'), { recursive: true })
  await writeFile(join(home, 'capability-center', 'engine-state.json'), JSON.stringify({
    schemaVersion: 1,
    current: { version: '0.1.9', source: 'http://127.0.0.1/core.zip' },
    previous: null,
    pending: null,
    bootAttempt: null,
    lastFailure: null,
    updatedAt: new Date().toISOString(),
  }))
  try {
    await withHome(home, async () => {
      const supervisor = new EngineSupervisor(supervisorContext(), {
        packageRoot,
        devSeed: true,
      })
      const status = await supervisor.ready
      assert.equal(status.ready, true)
      assert.equal(status.current.version, '0.2.0')
      assert.equal(status.current.source, 'dev-seed')
      assert.equal(status.previous.version, '0.1.9')
      assert.equal(supervisor.engine.version, '0.2.0')
      await supervisor.dispose()
    })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('an isolated bundled seed version is not automatically promoted again', async () => {
  const temp = await tempRoot('capability-center-core-dev-seed-isolated-')
  const home = join(temp, 'home')
  const packageRoot = await seedPackageRoot(temp)
  await writeCoreDirectory(
    join(home, 'capability-center', 'releases', '0.1.9'),
    '0.1.9',
  )
  await mkdir(join(home, 'capability-center'), { recursive: true })
  await writeFile(join(home, 'capability-center', 'engine-state.json'), JSON.stringify({
    schemaVersion: 1,
    current: { version: '0.1.9', source: 'http://127.0.0.1/core.zip' },
    previous: null,
    pending: null,
    bootAttempt: null,
    lastFailure: { version: '0.2.0', message: 'seed failed', at: new Date().toISOString() },
    updatedAt: new Date().toISOString(),
  }))
  try {
    await withHome(home, async () => {
      const supervisor = new EngineSupervisor(supervisorContext(), {
        packageRoot,
        devSeed: true,
      })
      const status = await supervisor.ready
      assert.equal(status.ready, true)
      assert.equal(status.current.version, '0.1.9')
      assert.equal(supervisor.engine.version, '0.1.9')
      await supervisor.dispose()
    })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('dev seed recovery resolves the bundled seed when rolling back a failed current release', async () => {
  const temp = await tempRoot('capability-center-core-dev-seed-recovery-')
  const home = join(temp, 'home')
  const packageRoot = await seedPackageRoot(temp)
  await writeCoreDirectory(
    join(home, 'capability-center', 'releases', '0.2.0'),
    '0.2.0',
    'fail',
  )
  await mkdir(join(home, 'capability-center'), { recursive: true })
  await writeFile(join(home, 'capability-center', 'engine-state.json'), JSON.stringify({
    schemaVersion: 1,
    current: { version: '0.2.1', source: 'http://127.0.0.1/core.zip' },
    previous: { version: '0.2.0', source: 'seed' },
    pending: null,
    bootAttempt: null,
    lastFailure: null,
    updatedAt: new Date().toISOString(),
  }))
  try {
    await withHome(home, async () => {
      const supervisor = new EngineSupervisor(supervisorContext(), {
        packageRoot,
        devSeed: true,
        devDistributionUrl: undefined,
      })
      const status = await supervisor.ready
      assert.equal(status.ready, true)
      assert.equal(status.current.version, '0.2.0')
      assert.equal(status.current.source, 'seed')
      assert.equal(supervisor.engine.version, '0.2.0')
      await supervisor.dispose()
    })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('development distribution URL is loopback-only and the page meta appears only when configured', async () => {
  assert.equal(
    normalizeDevDistributionUrl('http://127.0.0.1:8765'),
    'http://127.0.0.1:8765/',
  )
  assert.throws(
    () => normalizeDevDistributionUrl('http://192.168.1.2:8765/'),
    error => error.code === 'invalid-dev-distribution-url',
  )
  assert.throws(
    () => normalizeDevDistributionUrl('https://127.0.0.1:8765/'),
    error => error.code === 'invalid-dev-distribution-url',
  )

  const temp = await tempRoot('capability-center-dev-meta-')
  const home = join(temp, 'home')
  const files = readZip(await readFile(join(dist, 'core', 'capability-center-core-0.2.12.zip')))
  const coreRoot = join(temp, 'release')
  for (const [name, bytes] of files) {
    const target = join(coreRoot, ...name.split('/'))
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, bytes)
  }
  const { CoreService: BuiltCoreService } = await import(
    pathToFileURL(join(coreRoot, 'engine', 'service.js')).href
  )
  const page = async devDistributionUrl => {
    const service = new BuiltCoreService(fakeContext(), {
      version: '0.2.12',
      dataRoot: join(home, 'capability-center'),
      http: { readBoundedUrl },
      devDistributionUrl,
    })
    await service.initialize()
    const chunks = []
    const headers = new Map()
    const req = {
      method: 'GET',
      headers: {},
      async *[Symbol.asyncIterator]() {},
    }
    const res = {
      statusCode: 0,
      setHeader(name, value) { headers.set(name.toLowerCase(), String(value)) },
      end(value = '') { chunks.push(Buffer.from(value)) },
    }
    assert.equal(await service.handle(req, res, '/', new URL('http://127.0.0.1/')), true)
    assert.equal(res.statusCode, 200)
    await service.dispose()
    return Buffer.concat(chunks).toString('utf8')
  }
  try {
    await withHome(home, async () => {
      const development = await page('http://127.0.0.1:8765/')
      assert.match(
        development,
        /<meta name="capability-center-dev-distribution-url" content="http:\/\/127\.0\.0\.1:8765\/">/u,
      )
      const production = await page(undefined)
      assert.doesNotMatch(production, /capability-center-dev-distribution-url/u)
    })
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('pending candidate that exits the process is quarantined and previous core recovers on next start', async () => {
  const temp = await tempRoot('capability-center-core-exit-')
  const home = join(temp, 'home')
  const packageRoot = await seedPackageRoot(temp)
  const exiting = await makeCoreZip(join(temp, 'exit.zip'), '0.2.1', 'exit')
  const server = await startFileServer(new Map([
    ['/core-release-index.json', Buffer.from(JSON.stringify(
      releaseIndex([{ version: '0.2.1', bytes: exiting }]),
    ))],
    ['/core/capability-center-core-0.2.1.zip', exiting],
  ]))
  try {
    await withHome(home, async () => {
      const staging = new EngineSupervisor(supervisorContext(), { packageRoot })
      await staging.ready
      await staging.stage(server.base)
      await staging.dispose()

      const source = [
        `import { EngineSupervisor } from ${JSON.stringify(pathToFileURL(join(
          import.meta.dirname,
          '..',
          'apps',
          'dsh-plugin',
          'bootstrap',
          'lib',
          'supervisor.js',
        )).href)}`,
        'const ctx = { logger:{warn(){}}, plugin(plugin, config) {',
        '  const child = Object.create(ctx); const disposers = [];',
        '  child.effect = callback => { const value = callback(); disposers.push(value); return value };',
        '  const fiber = { await: async () => { await plugin.apply(child, config); return fiber }, dispose: async () => { for (const value of disposers.reverse()) await value?.() } };',
        '  return fiber;',
        '} };',
        `const supervisor = new EngineSupervisor(ctx, { packageRoot: ${JSON.stringify(packageRoot)} });`,
        'await supervisor.ready;',
      ].join('\n')
      const child = spawn(node, ['--input-type=module', '--eval', source], {
        env: { ...process.env, DSH_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += chunk })
      const code = await new Promise(resolveExit => child.once('exit', resolveExit))
      assert.equal(code, 37, stderr)
      const interrupted = JSON.parse(await readFile(
        join(home, 'capability-center', 'engine-state.json'),
        'utf8',
      ))
      assert.equal(interrupted.bootAttempt.version, '0.2.1')
      assert.equal(interrupted.current.version, '0.2.0')

      const recovered = new EngineSupervisor(supervisorContext(), { packageRoot })
      const status = await recovered.ready
      assert.equal(status.ready, true)
      assert.equal(status.current.version, '0.2.0')
      assert.equal(status.pending, null)
      assert.equal(status.bootAttempt, null)
      assert.equal(status.lastFailure.version, '0.2.1')
      assert.match(status.lastFailure.message, /启动未完成/u)
      assert.equal(recovered.engine.version, '0.2.0')
      await assert.rejects(
        access(join(home, 'capability-center', 'releases', '0.2.1')),
        error => error.code === 'ENOENT',
      )
      await recovered.dispose()
    })
  } finally {
    await server.close()
    await rm(temp, { recursive: true, force: true })
  }
})

test('actual built core ZIP serves its UI from the release-root page directory', async () => {
  const temp = await tempRoot('capability-center-built-core-page-')
  const home = join(temp, 'home')
  try {
    const files = readZip(await readFile(join(dist, 'core', 'capability-center-core-0.2.12.zip')))
    assert.equal([...files.keys()].some(name => name.endsWith('.ts')), false)
    const coreRoot = join(temp, 'release')
    for (const [name, bytes] of files) {
      const target = join(coreRoot, ...name.split('/'))
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
    }
    const module = await import(pathToFileURL(join(coreRoot, 'engine', 'index.js')).href)
    let engine
    const cleanups = []
    const ctx = {
      skills: {
        async get() { return undefined },
        register() { return () => undefined },
      },
      tools: {
        async execute() {
          return { isError: false, value: {}, content: [{ type: 'text', text: '{}' }] }
        },
      },
      pluginManager: {
        async listBundles() { return [] },
      },
      effect(callback) {
        const value = callback()
        cleanups.push(value)
        return value
      },
    }
    await withHome(home, async () => {
      await module.apply(ctx, {
        runtime: {
          version: '0.2.12',
          dataRoot: join(home, 'capability-center'),
          http: { readBoundedUrl },
          setEngine(value) { engine = value },
        },
      })
      for (const [route, expected] of [
        ['/', /<h1>能力中心<\/h1>/u],
        ['/app.js', /capability-center\/api\/status/u],
        ['/styles.css', /--blue:\s*#4059dc/u],
      ]) {
        const chunks = []
        const headers = new Map()
        const req = {
          method: 'GET',
          headers: {},
          async *[Symbol.asyncIterator]() {},
        }
        const res = {
          statusCode: 0,
          setHeader(name, value) { headers.set(name.toLowerCase(), String(value)) },
          end(value = '') { chunks.push(Buffer.from(value)) },
        }
        assert.equal(
          await engine.handle(req, res, route, new URL(route, 'https://dsh.local')),
          true,
        )
        assert.equal(res.statusCode, 200, route)
        assert.match(Buffer.concat(chunks).toString('utf8'), expected)
      }
      await engine.dispose()
    })
    for (const cleanup of cleanups.reverse()) await cleanup?.()
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

