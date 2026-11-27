import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  access,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { CoreService } from '../apps/dsh-plugin/core/service.js'
import { readBoundedUrl } from '../apps/dsh-plugin/bootstrap/lib/http-transport.js'
import {
  catalog,
  createVenv,
  dist,
  fakeContext,
  flatComposite,
  readCatalog,
  runtimeSkills,
  startFileServer,
  tempRoot,
} from './helpers.js'

const runFile = promisify(execFile)

function serviceFor(home, context, faultInjection) {
  return new CoreService(context, {
    version: '0.2.2',
    dataRoot: join(home, 'capability-center'),
    http: { readBoundedUrl },
    dshHome: home,
    faultInjection,
  })
}

async function wait(service, operation) {
  return await service.waitForOperation(operation.id)
}

async function installFull(service, base, id) {
  return await wait(service, service.startAction(base, id, 'install'))
}

async function installPypdf(directory) {
  const runtime = await createVenv(directory, { systemSitePackages: true })
  await runFile(runtime.python, [
    '-m',
    'pip',
    'install',
    '--disable-pip-version-check',
    '--no-index',
    '--no-deps',
    join(dist, 'packages', 'pypdf-7.1.0-py3-none-any.whl'),
  ], {
    timeout: 60_000,
    maxBuffer: 4 * 1024 * 1024,
  })
  return runtime
}

async function officeServer(extraItems = []) {
  const built = await readCatalog()
  const routes = new Map([
    ['/catalog.json', Buffer.from(JSON.stringify(catalog([...built.items, ...extraItems])))],
  ])
  for (const item of built.items) {
    if (item.artifact !== undefined) {
      routes.set(`/${item.artifact.path}`, await readFile(join(dist, item.artifact.path)))
    }
  }
  return await startFileServer(routes)
}

test('real DSH Python installs Office, borrows pip-installed pypdf, reuses it without artifact endpoints, and releases only ledger references', async () => {
  const temp = await tempRoot('capability-center-office-borrow-')
  const home = join(temp, 'home')
  const runtime = await installPypdf(join(temp, 'venv'))
  const skills = runtimeSkills()
  const context = fakeContext({ runtime, skills })
  const service = serviceFor(home, context)
  let server
  try {
    const direct = flatComposite('office-enhancement-copy', [
      { id: 'office-enhancement-skill', version: '1.0.0' },
      { id: 'python-pypdf', version: '7.1.0' },
    ], 'Office 增强第二入口')
    server = await officeServer([direct])
    await service.initialize()

    const hidden = await wait(service, service.startAction(
      server.base,
      'office-enhancement-skill',
      'install',
    ))
    assert.equal(hidden.status, 'failed')
    assert.match(hidden.error, /component-only|隐藏组件/u)

    const installed = await installFull(service, server.base, 'office-enhancement')
    assert.equal(installed.status, 'ready', installed.error)
    assert.equal(service.ledger.get('office-enhancement-skill').preexisting, undefined)
    assert.equal(service.ledger.get('python-pypdf').borrowed, true)
    assert.equal(service.ledger.get('python-pypdf').preexisting, true)
    assert.equal(service.ledger.get('python-pypdf').pth, undefined)
    assert.ok((await skills.get('office-enhancement-skill')).content.includes('Office 增强'))
    await assert.rejects(
      access(join(home, 'skills', 'office-enhancement-skill', 'scripts', '__pycache__')),
      error => error.code === 'ENOENT',
    )

    server.routes.delete('/packages/office-enhancement-skill-1.0.0.zip')
    server.routes.delete('/packages/pypdf-7.1.0-py3-none-any.whl')
    const shared = await installFull(service, server.base, 'office-enhancement-copy')
    assert.equal(shared.status, 'ready', shared.error)
    assert.deepEqual(
      service.ledger.get('python-pypdf').dependencyOwners,
      ['office-enhancement', 'office-enhancement-copy'],
    )

    const removedCopy = await wait(service, service.startAction(
      server.base,
      'office-enhancement-copy',
      'uninstall',
    ))
    assert.equal(removedCopy.status, 'ready', removedCopy.error)
    assert.deepEqual(
      service.ledger.get('python-pypdf').dependencyOwners,
      ['office-enhancement'],
    )

    const removed = await wait(service, service.startAction(
      server.base,
      'office-enhancement',
      'uninstall',
    ))
    assert.equal(removed.status, 'ready', removed.error)
    assert.equal(service.ledger.get('office-enhancement-skill'), undefined)
    assert.equal(service.ledger.get('python-pypdf'), undefined)
    assert.equal(await skills.get('office-enhancement-skill'), undefined)
    await assert.rejects(
      access(join(home, 'skills', 'office-enhancement-skill')),
      error => error.code === 'ENOENT',
    )
    const probe = await runFile(runtime.python, [
      '-I',
      '-c',
      'import importlib.metadata, pypdf; print(importlib.metadata.version("pypdf"))',
    ])
    assert.match(probe.stdout, /^7\.1\.0/mu)
  } finally {
    await service.dispose()
    await server?.close()
    await rm(temp, { recursive: true, force: true })
  }
})

test('Office install rolls back a newly registered skill and leaves borrowed pypdf untouched', async () => {
  const temp = await tempRoot('capability-center-office-rollback-')
  const home = join(temp, 'home')
  const runtime = await installPypdf(join(temp, 'venv'))
  const skills = runtimeSkills()
  const service = serviceFor(
    home,
    fakeContext({ runtime, skills }),
    async (label, details) => {
      if (label === 'child-installed' && details.itemId === 'office-enhancement-skill') {
        throw new Error('office fixture rollback')
      }
    },
  )
  const server = await officeServer()
  try {
    await service.initialize()
    const failed = await installFull(service, server.base, 'office-enhancement')
    assert.equal(failed.status, 'failed')
    assert.match(failed.error, /office fixture rollback/u)
    assert.deepEqual(service.ledger.list(), [])
    assert.equal(await skills.get('office-enhancement-skill'), undefined)
    await assert.rejects(
      access(join(home, 'skills', 'office-enhancement-skill')),
      error => error.code === 'ENOENT',
    )
    const probe = await runFile(runtime.python, ['-I', '-c', 'import pypdf'])
    assert.equal(probe.stderr, '')
  } finally {
    await service.dispose()
    await server.close()
    await rm(temp, { recursive: true, force: true })
  }
})

test('matching pypdf metadata with broken files is rejected before the Office skill mutates', async () => {
  const temp = await tempRoot('capability-center-office-conflict-')
  const home = join(temp, 'home')
  const runtime = await installPypdf(join(temp, 'venv'))
  const pypdfInit = join(runtime.pythonPackages, 'pypdf', '__init__.py')
  await writeFile(pypdfInit, '# changed outside capability center\n')
  const service = serviceFor(home, fakeContext({
    runtime,
    skills: runtimeSkills(),
  }))
  const server = await officeServer()
  try {
    await service.initialize()
    const failed = await installFull(service, server.base, 'office-enhancement')
    assert.equal(failed.status, 'failed')
    assert.match(failed.error, /pypdf-conflict|RECORD|不一致/u)
    assert.deepEqual(service.ledger.list(), [])
    await assert.rejects(
      access(join(home, 'skills', 'office-enhancement-skill')),
      error => error.code === 'ENOENT',
    )
  } finally {
    await service.dispose()
    await server.close()
    await rm(temp, { recursive: true, force: true })
  }
})
