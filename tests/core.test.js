import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
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
import { EngineSupervisor } from '../src/bootstrap/lib/supervisor.js'
import { readZip } from '../src/engine/lib/archive.js'
import { readBoundedUrl } from '../src/bootstrap/lib/http-transport.js'
import {
  createZip,
  dist,
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
  return `export async function apply(ctx, config) {
  if (${JSON.stringify(mode)} === 'fail') throw new Error('candidate failed')
  config.runtime.setEngine({
    version: config.runtime.version,
    async handle() { return false },
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

function supervisorContext() {
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
      const fiber = {
        async await() {
          await plugin.apply(child, config)
          return fiber
        },
        async dispose() {
          for (const disposer of disposers.reverse()) await disposer?.()
          disposers = []
          disposedFlag = true
          disposed.push(config.runtime.version)
        },
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
          'src',
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
    const files = readZip(await readFile(join(dist, 'core', 'capability-center-core-0.2.6.zip')))
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
          version: '0.2.6',
          dataRoot: join(home, 'capability-center'),
          http: { readBoundedUrl },
          setEngine(value) { engine = value },
        },
      })
      for (const [route, expected] of [
        ['/', /<h1>能力中心<\/h1>/u],
        ['/app.js', /capability-center\/api\/status/u],
        ['/styles.css', /--blue:\s*#4d6bfe/u],
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

