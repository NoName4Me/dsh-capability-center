import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import {
  access,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { CoreService } from '../src/engine/service.js'
import { readZip } from '../src/engine/lib/archive.js'
import { LocalLedger } from '../src/engine/lib/ledger.js'
import { validateGraph } from '../src/engine/lib/graph.js'
import { readBoundedUrl } from '../src/bootstrap/lib/http-transport.js'
import {
  catalog,
  createSkillArchive,
  createVenv,
  fakeContext,
  flatComposite,
  python,
  readCatalog,
  root,
  runtimeSkills,
  sha256,
  skillItem,
  startFileServer,
  successfulTool,
  tempRoot,
  writeJson,
} from './helpers.js'

const runFile = promisify(execFile)

async function withHome(home, callback) {
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await callback()
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
}

function serviceFor(home, context, options = {}) {
  const http = typeof options.http === 'function'
    ? { readBoundedUrl: options.http }
    : options.http ?? { readBoundedUrl }
  return new CoreService(context, {
    version: options.version ?? '0.2.0',
    dataRoot: join(home, 'capability-center'),
    http,
    dshHome: home,
    faultInjection: options.faultInjection,
  })
}

async function wait(service, operation) {
  return await service.waitForOperation(operation.id)
}

async function installFull(service, base, id) {
  return await wait(service, service.startAction(base, id, 'install'))
}

const tabulatePath = 'packages/tabulate-0.9.0-py3-none-any.whl'

async function tabulateFixture() {
  return await readFile(join(root, 'tests', 'fixtures', 'tabulate-0.9.0-py3-none-any.whl'))
}

async function reportSkillFixture(directory) {
  return await readFile(await createSkillArchive(
    join(directory, 'report-format-1.0.0.zip'),
    'report-format',
    '1.0.0',
    '报告格式',
  ))
}

async function reportServer(directory) {
  const path = 'packages/report-format-1.0.0.zip'
  const bytes = await reportSkillFixture(directory)
  return await startFileServer([
    ['/catalog.json', catalog([skillItem('report-format', '1.0.0', path, bytes)])],
    [`/${path}`, bytes],
  ])
}

test('ledger protects prototype IDs and recovery rolls back a write before commit marker', async () => {
  const home = await tempRoot('capability-center-commit-boundary-')
  const dataRoot = join(home, 'capability-center')
  try {
    const ledger = new LocalLedger(dataRoot)
    await ledger.open()
    assert.equal(ledger.get('constructor'), undefined)
    await ledger.begin({
      operationId: 'crash-before-commit-marker',
      action: 'install',
      itemId: 'prototype-entry',
      beforeVersion: null,
      targetVersion: '1.0.0',
    })
    ledger.value.entries['prototype-entry'] = {
      id: 'prototype-entry',
      type: 'skill',
      version: '1.0.0',
      manifest: {},
    }
    // This is the first half of commit: the new ledger is on disk, but the
    // journal has not been marked committed yet.
    await ledger.write()

    const context = fakeContext({ skills: runtimeSkills() })
    const recovered = serviceFor(home, context)
    await recovered.initialize()
    try {
      assert.equal(recovered.ledger.get('prototype-entry'), undefined)
      assert.deepEqual(await readdir(ledger.journalRoot), [])
    } finally {
      await recovered.dispose()
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('unreadable operation journal survives restart and blocks further writes', async () => {
  const home = await tempRoot('capability-center-unreadable-journal-')
  const journalRoot = join(home, 'capability-center', 'operations')
  const journalPath = join(journalRoot, 'corrupt-operation.json')
  const corruptContent = '{"phase":"prepared", broken'
  try {
    await mkdir(journalRoot, { recursive: true })
    await writeFile(journalPath, corruptContent, 'utf8')

    const first = serviceFor(home, fakeContext({ skills: runtimeSkills() }))
    try {
      await first.initialize()
      assert.equal(first.recoveryRequired, true)
      assert.match(first.recoveryMessages.join('\n'), /无法解析/u)
      assert.equal(await readFile(journalPath, 'utf8'), corruptContent)
      assert.throws(
        () => first.startAction('', 'report-format', 'diagnose'),
        error => error?.code === 'recovery-required',
      )
    } finally {
      await first.dispose()
    }

    const restarted = serviceFor(home, fakeContext({ skills: runtimeSkills() }))
    try {
      await restarted.initialize()
      assert.equal(restarted.recoveryRequired, true)
      assert.equal(await readFile(journalPath, 'utf8'), corruptContent)
      assert.throws(
        () => restarted.startAction('', 'report-format', 'diagnose'),
        error => error?.code === 'recovery-required',
      )
    } finally {
      await restarted.dispose()
    }
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('fresh-home skill install and uninstall use real artifacts and leave no parent-path failure', async () => {
  const home = await tempRoot('capability-center-fresh-skill-')
  const server = await reportServer(home)
  const context = fakeContext({ skills: runtimeSkills() })
  const service = serviceFor(home, context, { http: (await import('../src/bootstrap/lib/http-transport.js')).readBoundedUrl })
  try {
    await service.initialize()
    const installed = await installFull(service, server.base, 'report-format')
    assert.equal(installed.status, 'ready', installed.error)
    assert.match(await readFile(join(home, 'skills', 'report-format', 'SKILL.md'), 'utf8'), /报告格式/u)
    assert.equal(service.ledger.get('report-format').ownedFiles.length, 2)
    const removed = await wait(service, service.startAction(server.base, 'report-format', 'uninstall'))
    assert.equal(removed.status, 'ready')
    await assert.rejects(access(join(home, 'skills', 'report-format')), error => error.code === 'ENOENT')
    assert.equal(service.ledger.get('report-format'), undefined)
  } finally {
    await service.dispose()
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

async function threeSkillFixture(fault) {
  const temp = await tempRoot('capability-center-journal-')
  const files = new Map()
  const items = []
  for (const id of ['skill-alpha', 'skill-beta', 'skill-gamma']) {
    const file = join(temp, 'packages', `${id}-1.0.0.zip`)
    const bytes = await readFile(await createSkillArchive(file, id, '1.0.0'))
    files.set(`/packages/${id}-1.0.0.zip`, bytes)
    items.push(skillItem(id, '1.0.0', `packages/${id}-1.0.0.zip`, bytes))
  }
  items.push(flatComposite('flat-fixture', [
    { id: 'skill-alpha', version: '1.0.0' },
    { id: 'skill-beta', version: '1.0.0' },
    { id: 'skill-gamma', version: '1.0.0' },
  ]))
  files.set('/catalog.json', Buffer.from(JSON.stringify(catalog(items))))
  return { temp, files }
}

test('ordinary exceptions after every flat child reload the latest journal and remove all partial files', async () => {
  for (const crashItem of ['skill-alpha', 'skill-beta', 'skill-gamma']) {
    const fixture = await threeSkillFixture()
    const home = join(fixture.temp, 'home')
    const server = await startFileServer(fixture.files)
    const context = fakeContext({ skills: runtimeSkills() })
    const service = serviceFor(home, context, {
      faultInjection: async (label, details) => {
        if (label === 'child-installed' && details.itemId === crashItem) {
          throw new Error(`ordinary failure after ${crashItem}`)
        }
      },
    })
    try {
      await service.initialize()
      const result = await installFull(service, server.base, 'flat-fixture')
      assert.equal(result.status, 'failed')
      assert.match(result.error, new RegExp(`ordinary failure after ${crashItem}`, 'u'))
      for (const id of ['skill-alpha', 'skill-beta', 'skill-gamma']) {
        await assert.rejects(access(join(home, 'skills', id)), error => error.code === 'ENOENT')
      }
      assert.deepEqual(service.ledger.list(), [])
      assert.equal(service.recoveryRequired, false)
      assert.deepEqual(await readdir(join(home, 'capability-center', 'operations')), [])
    } finally {
      await service.dispose()
      await server.close()
      await rm(fixture.temp, { recursive: true, force: true })
    }
  }
})

test('simulated process exit after every flat child recovers on restart without false success', async () => {
  for (const crashItem of ['skill-alpha', 'skill-beta', 'skill-gamma']) {
    const fixture = await threeSkillFixture()
    const home = join(fixture.temp, 'home')
    const server = await startFileServer(fixture.files)
    const first = serviceFor(home, fakeContext({ skills: runtimeSkills() }), {
      faultInjection: async (label, details) => {
        if (label === 'child-installed' && details.itemId === crashItem) return 'crash'
      },
    })
    try {
      await first.initialize()
      const crashed = await installFull(first, server.base, 'flat-fixture')
      assert.equal(crashed.status, 'failed')
      assert.equal(first.recoveryRequired, true)
    } finally {
      await first.dispose()
    }
    const recovered = serviceFor(home, fakeContext({ skills: runtimeSkills() }))
    try {
      await recovered.initialize()
      assert.equal(recovered.recoveryRequired, false)
      assert.deepEqual(recovered.ledger.list(), [])
      for (const id of ['skill-alpha', 'skill-beta', 'skill-gamma']) {
        await assert.rejects(access(join(home, 'skills', id)), error => error.code === 'ENOENT')
      }
      assert.deepEqual(await readdir(join(home, 'capability-center', 'operations')), [])
    } finally {
      await recovered.dispose()
      await server.close()
      await rm(fixture.temp, { recursive: true, force: true })
    }
  }
})

test('flat composites reject nested children and cycles/missing versions are validated', () => {
  const leaf = skillItem('leaf-skill', '1.0.0', 'packages/leaf-1.0.0.zip', Buffer.from('x'))
  const nested = flatComposite('nested-composite', [{ id: 'leaf-skill', version: '1.0.0' }])
  assert.throws(
    () => validateGraph(catalog([leaf, nested, flatComposite('outer-composite', [
      { id: 'nested-composite', version: '1.0.0' },
    ])])),
    error => error.code === 'unsupported-nested-composite',
  )
  assert.throws(
    () => validateGraph(catalog([flatComposite('missing-composite', [
      { id: 'absent-skill', version: '1.0.0' },
    ])])),
    error => error.code === 'missing-dependency',
  )
  assert.throws(
    () => validateGraph(catalog([leaf, flatComposite('pin-composite', [
      { id: 'leaf-skill', version: '2.0.0' },
    ])])),
    error => error.code === 'dependency-version-mismatch',
  )
})

test('shared dependencies retain references and a conflicting pinned owner blocks direct updates', async () => {
  const temp = await tempRoot('capability-center-dependencies-')
  const home = join(temp, 'home')
  const v1 = await readFile(await createSkillArchive(
    join(temp, 'packages', 'shared-skill-1.0.0.zip'),
    'shared-skill',
    '1.0.0',
  ))
  const v11 = await readFile(await createSkillArchive(
    join(temp, 'packages', 'shared-skill-1.1.0.zip'),
    'shared-skill',
    '1.1.0',
  ))
  const routes = new Map([
    ['/packages/shared-skill-1.0.0.zip', v1],
    ['/packages/shared-skill-1.1.0.zip', v11],
  ])
  const leafV1 = skillItem('shared-skill', '1.0.0', 'packages/shared-skill-1.0.0.zip', v1)
  const comboA = flatComposite('combo-a', [{ id: 'shared-skill', version: '1.0.0' }], '组合 A')
  const comboB = flatComposite('combo-b', [{ id: 'shared-skill', version: '1.0.0' }], '组合 B')
  routes.set('/catalog.json', Buffer.from(JSON.stringify(catalog([leafV1, comboA, comboB]))))
  const server = await startFileServer(routes)
  const service = serviceFor(home, fakeContext({ skills: runtimeSkills() }))
  try {
    await service.initialize()
    assert.equal((await installFull(service, server.base, 'shared-skill')).status, 'ready')
    assert.equal((await installFull(service, server.base, 'combo-a')).status, 'ready')
    assert.equal((await installFull(service, server.base, 'combo-b')).status, 'ready')
    assert.deepEqual(service.ledger.get('shared-skill').dependencyOwners, ['combo-a', 'combo-b'])

    const leafV11 = skillItem('shared-skill', '1.1.0', 'packages/shared-skill-1.1.0.zip', v11)
    server.routes.set('/catalog.json', Buffer.from(JSON.stringify(catalog([leafV11]))))
    const conflict = await wait(service, service.startAction(server.base, 'shared-skill', 'update'))
    assert.equal(conflict.status, 'failed')
    assert.match(conflict.error, /dependency-conflict|仍固定 shared-skill@1\.0\.0/u)
    assert.equal(service.ledger.get('shared-skill').version, '1.0.0')

    assert.equal((await wait(service, service.startAction(server.base, 'combo-a', 'uninstall'))).status, 'ready')
    assert.deepEqual(service.ledger.get('shared-skill').dependencyOwners, ['combo-b'])
    const directRemoval = await wait(service, service.startAction(server.base, 'shared-skill', 'uninstall'))
    assert.equal(directRemoval.activation, 'retained')
    assert.equal(service.ledger.get('shared-skill').rootInstalled, false)
    assert.equal((await wait(service, service.startAction(server.base, 'combo-b', 'uninstall'))).status, 'ready')
    assert.equal(service.ledger.get('shared-skill'), undefined)
    await assert.rejects(access(join(home, 'skills', 'shared-skill')), error => error.code === 'ENOENT')
  } finally {
    await service.dispose()
    await server.close()
    await rm(temp, { recursive: true, force: true })
  }
})

test('ordinary installed skills update from 1.0.0 to 1.1.0 and replace their owned files', async () => {
  const home = await tempRoot('capability-center-ordinary-update-')
  const one = await readFile(await createSkillArchive(
    join(home, 'packages', 'normal-update-skill-1.0.0.zip'),
    'normal-update-skill',
    '1.0.0',
  ))
  const eleven = await readFile(await createSkillArchive(
    join(home, 'packages', 'normal-update-skill-1.1.0.zip'),
    'normal-update-skill',
    '1.1.0',
  ))
  const routes = new Map([
    ['/packages/normal-update-skill-1.0.0.zip', one],
    ['/packages/normal-update-skill-1.1.0.zip', eleven],
    ['/catalog.json', Buffer.from(JSON.stringify(catalog([
      skillItem('normal-update-skill', '1.0.0', 'packages/normal-update-skill-1.0.0.zip', one),
    ])))],
  ])
  const server = await startFileServer(routes)
  const service = serviceFor(home, fakeContext({ skills: runtimeSkills() }))
  try {
    await service.initialize()
    assert.equal((await installFull(service, server.base, 'normal-update-skill')).status, 'ready')
    routes.set('/catalog.json', Buffer.from(JSON.stringify(catalog([
      skillItem('normal-update-skill', '1.1.0', 'packages/normal-update-skill-1.1.0.zip', eleven),
    ]))))
    const updated = await wait(service, service.startAction(server.base, 'normal-update-skill', 'update'))
    assert.equal(updated.status, 'ready', updated.error)
    assert.equal(updated.activation, 'applied')
    assert.equal(service.ledger.get('normal-update-skill').version, '1.1.0')
    assert.match(
      await readFile(join(home, 'skills', 'normal-update-skill', 'scripts', 'info.txt'), 'utf8'),
      /1\.1\.0/u,
    )
  } finally {
    await service.dispose()
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('delisted and fully offline installed skills remain visible, diagnosable, and uninstallable', async () => {
  const home = await tempRoot('capability-center-offline-')
  const server = await reportServer(home)
  const skills = runtimeSkills()
  const service = serviceFor(home, fakeContext({ skills }))
  try {
    await service.initialize()
    assert.equal((await installFull(service, server.base, 'report-format')).status, 'ready')
    server.routes.set('/catalog.json', Buffer.from(JSON.stringify(catalog([]))))
    const delisted = await service.inspect(server.base)
    const report = delisted.catalog.items.find(item => item.id === 'report-format')
    assert.ok(report)
    assert.equal(report.delisted, true)
    assert.equal(report.artifact, undefined)
    assert.equal((await wait(service, service.startAction(server.base, 'report-format', 'diagnose'))).status, 'ready')

    await server.close()
    const offline = await service.inspect('')
    assert.equal(offline.online, false)
    assert.equal(offline.localStates['report-format'].installed, true)
    const removed = await wait(service, service.startAction('', 'report-format', 'uninstall'))
    assert.equal(removed.status, 'ready')
    assert.equal(service.ledger.get('report-format'), undefined)
  } finally {
    await service.dispose()
    await rm(home, { recursive: true, force: true })
  }
})

test('diagnose, trial, and uninstall use the installed manifest when the catalog publishes a newer contract', async () => {
  const home = await tempRoot('capability-center-local-manifest-')
  const oldBytes = Buffer.from('managed-plugin-v1')
  const newBytes = Buffer.from('managed-plugin-v2')
  const plugin = (version, packageName, tool, prompt) => ({
    id: 'managed-plugin',
    type: 'plugin',
    name: '本机托管插件',
    version,
    description: 'local manifest fixture',
    compatibility: { dsh: '0.2.1-rc.2', os: [process.platform], arch: [process.arch] },
    artifact: {
      path: `packages/managed-plugin-${version}.tgz`,
      sha256: sha256(version === '1.0.0' ? oldBytes : newBytes),
      bytes: (version === '1.0.0' ? oldBytes : newBytes).length,
    },
    dependencies: [],
    install: { packageName },
    checks: [{ type: 'named-tool-readonly-call', tool }],
    usage: { steps: ['安装。', '诊断。'], inputs: '无。', output: '结果。', example: '检查。' },
    trial: { prompt },
  })
  const oldItem = plugin(
    '1.0.0',
    'old-package',
    'old_tool',
    '旧版安装说明\n不要自动发送。',
  )
  const newItem = plugin(
    '2.0.0',
    'new-package',
    'new_tool',
    '新版安装说明\n不要自动发送。',
  )
  const server = await startFileServer(new Map([
    ['/catalog.json', Buffer.from(JSON.stringify(catalog([oldItem])))],
    ['/packages/managed-plugin-1.0.0.tgz', oldBytes],
    ['/packages/managed-plugin-2.0.0.tgz', newBytes],
  ]))
  const probed = []
  const context = fakeContext({
    bundleName: 'old-package',
    toolResult: async request => {
      probed.push(request.name)
      return successfulTool(request)
    },
  })
  const service = serviceFor(home, context)
  try {
    await service.initialize()
    assert.equal((await installFull(service, server.base, 'managed-plugin')).status, 'ready')
    server.routes.set('/catalog.json', Buffer.from(JSON.stringify(catalog([newItem]))))
    probed.length = 0
    const diagnosed = await wait(service, service.startAction(server.base, 'managed-plugin', 'diagnose'))
    assert.equal(diagnosed.status, 'ready', diagnosed.error)
    assert.deepEqual(probed, ['old_tool'])
    const trial = await service.prepareTrial(
      server.base,
      'managed-plugin',
      'request_local_manifest',
      'test',
      'https://dsh.local',
    )
    assert.match(trial.prompt, /^旧版安装说明/u)
    assert.equal(trial.prompt.includes('\n'), true)
    const removed = await wait(service, service.startAction(server.base, 'managed-plugin', 'uninstall'))
    assert.equal(removed.status, 'ready', removed.error)
    assert.ok(context.calls.some(call => call.kind === 'removeBundle' && call.name === 'old-package'))
    assert.equal(context.calls.some(call => call.kind === 'removeBundle' && call.name === 'new-package'), false)
  } finally {
    await service.dispose()
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

// Recreate the v0.1.2 on-disk format using test fixtures.
async function writeLegacyFixture(home, archive, receipt) {
  const records = []
  for (const [path, content] of readZip(archive)) {
    const destination = join(receipt.root, path)
    await mkdir(join(destination, '..'), { recursive: true })
    await writeFile(destination, content)
    records.push({ path, bytes: content.length, sha256: sha256(content) })
  }
  await writeJson(join(home, 'capability-center', 'installed', `${receipt.id}.json`), {
    schemaVersion: 1,
    installedAt: '2026-01-01T00:00:00.000Z',
    ...receipt,
    records,
  })
}

test('v0.1.2-format receipts migrate for offline inspect, diagnosis, and safe uninstall', async () => {
  const temp = await tempRoot('capability-center-legacy-real-')
  const skillHome = join(temp, 'skill-home')
  const pythonHome = join(temp, 'python-home')
  const skillBytes = await reportSkillFixture(temp)
  await writeLegacyFixture(skillHome, skillBytes, {
    id: 'report-format',
    type: 'skill',
    version: '1.0.0',
    root: join(skillHome, 'skills'),
    target: join(skillHome, 'skills', 'report-format'),
  })
  const legacyReceipt = JSON.parse(await readFile(
    join(skillHome, 'capability-center', 'installed', 'report-format.json'),
    'utf8',
  ))
  assert.equal(legacyReceipt.root, join(skillHome, 'skills'))
  assert.equal(legacyReceipt.target, join(skillHome, 'skills', 'report-format'))
  assert.ok(legacyReceipt.records.some(record => record.path.startsWith('report-format/')))

  await withHome(skillHome, async () => {
    const service = serviceFor(skillHome, fakeContext({
      skills: runtimeSkills(),
      bundles: [['capability-center-demo', {
        name: 'capability-center-demo',
        installed: true,
        enabled: true,
      }]],
    }))
    try {
      await service.initialize()
      const summary = await service.inspect('')
      const item = summary.catalog.items.find(candidate => candidate.id === 'report-format')
      assert.ok(item)
      assert.equal(item.artifact, undefined)
      assert.equal(summary.legacyManagerEnabled, true)
      assert.equal(summary.localStates['report-format'].legacy, true)
      assert.equal((await wait(service, service.startAction('', 'report-format', 'diagnose'))).status, 'ready')
      const removed = await wait(service, service.startAction('', 'report-format', 'uninstall'))
      assert.equal(removed.status, 'ready')
      assert.equal(service.ledger.get('report-format'), undefined)
      await assert.rejects(
        access(join(skillHome, 'skills', 'report-format')),
        error => error.code === 'ENOENT',
      )
    } finally {
      await service.dispose()
    }

    const recovered = serviceFor(skillHome, fakeContext({ skills: runtimeSkills() }))
    try {
      await recovered.initialize()
      const summary = await recovered.inspect('')
      assert.equal(summary.catalog.items.some(item => item.id === 'report-format'), false)
      assert.equal(summary.localStates['report-format'], undefined)
      assert.equal(recovered.ledger.get('report-format'), undefined)
      assert.ok(await readFile(
        join(skillHome, 'capability-center', 'installed', 'report-format.json'),
        'utf8',
      ))
    } finally {
      await recovered.dispose()
    }
  })

  const runtime = await createVenv(join(temp, 'legacy-venv'))
  const wheel = await tabulateFixture()
  await writeLegacyFixture(pythonHome, wheel, {
    id: 'python-tabulate',
    type: 'python',
    version: '0.9.0',
    root: runtime.pythonPackages,
    pythonPackages: runtime.pythonPackages,
  })
  const pythonReceipt = JSON.parse(await readFile(
    join(pythonHome, 'capability-center', 'installed', 'python-tabulate.json'),
    'utf8',
  ))
  assert.equal(pythonReceipt.root, runtime.pythonPackages)
  assert.equal(pythonReceipt.pythonPackages, runtime.pythonPackages)
  await withHome(pythonHome, async () => {
    const service = serviceFor(pythonHome, fakeContext({ runtime }))
    try {
      await service.initialize()
      const summary = await service.inspect('')
      assert.equal(summary.localStates['python-tabulate'].legacy, true)
      assert.equal((await wait(service, service.startAction('', 'python-tabulate', 'diagnose'))).status, 'ready')
      assert.equal((await wait(service, service.startAction('', 'python-tabulate', 'uninstall'))).status, 'ready')
      await assert.rejects(
        runFile(runtime.python, ['-s', '-c', 'import tabulate']),
        error => /ModuleNotFoundError|No module named/u.test(String(error.stderr)),
      )
    } finally {
      await service.dispose()
    }

    const recovered = serviceFor(pythonHome, fakeContext({ runtime }))
    try {
      await recovered.initialize()
      const summary = await recovered.inspect('')
      assert.equal(summary.catalog.items.some(item => item.id === 'python-tabulate'), false)
      assert.equal(summary.localStates['python-tabulate'], undefined)
      assert.equal(recovered.ledger.get('python-tabulate'), undefined)
      assert.ok(await readFile(
        join(pythonHome, 'capability-center', 'installed', 'python-tabulate.json'),
        'utf8',
      ))
    } finally {
      await recovered.dispose()
    }
  })
  await rm(temp, { recursive: true, force: true })
})

test('a center-managed install uninstalled while an old receipt remains stays absent after restart', async () => {
  const home = await tempRoot('capability-center-new-install-stale-receipt-')
  const server = await reportServer(home)
  const service = serviceFor(home, fakeContext({ skills: runtimeSkills() }))
  const receiptPath = join(home, 'capability-center', 'installed', 'report-format.json')
  try {
    await service.initialize()
    assert.equal((await installFull(service, server.base, 'report-format')).status, 'ready')
    await mkdir(join(home, 'capability-center', 'installed'), { recursive: true })
    await writeFile(receiptPath, `${JSON.stringify({
      id: 'report-format',
      type: 'skill',
      version: '1.0.0',
      root: join(home, 'skills'),
      target: join(home, 'skills', 'report-format'),
      records: [],
    }, null, 2)}\n`, 'utf8')
    assert.equal((await wait(service, service.startAction(server.base, 'report-format', 'uninstall'))).status, 'ready')
    const persisted = JSON.parse(await readFile(
      join(home, 'capability-center', 'data', 'ledger.json'),
      'utf8',
    ))
    assert.equal(persisted.migrationTombstones['report-format'].reason, 'uninstalled')
  } finally {
    await service.dispose()
  }

  const recovered = serviceFor(home, fakeContext({ skills: runtimeSkills() }))
  try {
    await recovered.initialize()
    const summary = await recovered.inspect('')
    assert.equal(summary.catalog.items.some(item => item.id === 'report-format'), false)
    assert.equal(summary.localStates['report-format'], undefined)
    assert.equal(recovered.ledger.get('report-format'), undefined)
    assert.ok(await readFile(receiptPath, 'utf8'))
  } finally {
    await recovered.dispose()
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('plugin restart-required is reprobed after service restart and stale activation clears', async () => {
  const home = await tempRoot('capability-center-plugin-restart-')
  const pluginBytes = Buffer.from('plugin-v1')
  const item = {
    id: 'test-plugin',
    type: 'plugin',
    name: '测试插件',
    version: '1.0.0',
    description: 'fixture',
    compatibility: { dsh: '0.2.1-rc.2', os: [process.platform], arch: [process.arch] },
    artifact: { path: 'packages/test-plugin-1.0.0.tgz', sha256: sha256(pluginBytes), bytes: pluginBytes.length },
    dependencies: [],
    install: { packageName: 'test-plugin' },
    checks: [{ type: 'named-tool-readonly-call', tool: 'test_tool' }],
    usage: { steps: ['安装。', '重启。'], inputs: '无。', output: '结果。', example: '检查。' },
    trial: { prompt: '测试插件\n不要自动发送。' },
  }
  const server = await startFileServer(new Map([
    ['/catalog.json', Buffer.from(JSON.stringify(catalog([item])))],
    ['/packages/test-plugin-1.0.0.tgz', pluginBytes],
  ]))
  try {
    const first = serviceFor(home, fakeContext({
      bundleName: 'test-plugin',
      installBundle: async () => ({
        application: 'restart-required',
        changed: true,
        stage: 'install',
        target: 'test-plugin',
        restartReason: 'no-hmr',
      }),
      toolResult: async () => undefined,
    }))
    await first.initialize()
    const installed = await installFull(first, server.base, item.id)
    assert.equal(installed.status, 'restart-required')
    assert.equal(first.ledger.get(item.id).bundle.application, 'restart-required')
    await first.dispose()

    const second = serviceFor(home, fakeContext({ toolResult: successfulTool }))
    try {
      await second.initialize()
      const entry = second.ledger.get(item.id)
      assert.equal(entry.latestHealth.status, 'ready')
      assert.equal(entry.bundle.application, 'applied')
      const summary = await second.inspect('')
      assert.equal(summary.localStates[item.id].ready, true)
    } finally {
      await second.dispose()
    }
  } finally {
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('plugin checks reject missing results and failed updates restore the cached old TGZ', async () => {
  const home = await tempRoot('capability-center-plugin-rollback-')
  const oldBytes = Buffer.from('plugin-v1')
  const newBytes = Buffer.from('plugin-v2')
  const item = version => ({
    id: 'test-plugin',
    type: 'plugin',
    name: '测试插件',
    version,
    description: 'fixture',
    compatibility: { dsh: '0.2.1-rc.2', os: [process.platform], arch: [process.arch] },
    artifact: {
      path: `packages/test-plugin-${version}.tgz`,
      sha256: sha256(version === '1.0.0' ? oldBytes : newBytes),
      bytes: (version === '1.0.0' ? oldBytes : newBytes).length,
    },
    dependencies: [],
    install: { packageName: 'test-plugin' },
    checks: [{ type: 'named-tool-readonly-call', tool: 'test_tool' }],
    usage: { steps: ['安装。', '检查。'], inputs: '无。', output: '结果。', example: '检查。' },
    trial: { prompt: '测试插件\n不要自动发送。' },
  })
  const server = await startFileServer(new Map([
    ['/catalog.json', Buffer.from(JSON.stringify(catalog([item('1.0.0')])))],
    ['/packages/test-plugin-1.0.0.tgz', oldBytes],
    ['/packages/test-plugin-1.1.0.tgz', newBytes],
  ]))

  const missingContext = fakeContext({
    bundleName: 'test-plugin',
    toolResult: async () => undefined,
  })
  const missingService = serviceFor(join(home, 'missing'), missingContext)
  await missingService.initialize()
  const missing = await installFull(missingService, server.base, item('1.0.0').id)
  assert.equal(missing.status, 'failed')
  assert.match(missing.error, /未返回可证明成功/u)
  assert.equal(missingService.ledger.get('test-plugin'), undefined)
  await missingService.dispose()

  const context = fakeContext({
    bundleName: 'test-plugin',
    toolResult: successfulTool,
    installBundle: async (spec, _options, bundles) => {
      if (spec.includes('1.1.0')) {
        return {
          application: 'failed',
          changed: false,
          stage: 'install',
          target: 'test-plugin',
          error: { code: 'fixture', diagnostic: 'new version rejected' },
        }
      }
      bundles.set('test-plugin', {
        name: 'test-plugin',
        installed: true,
        enabled: true,
        version: spec.includes('1.0.0') ? '1.0.0' : undefined,
      })
      return { application: 'applied', changed: true, stage: 'install', target: 'test-plugin' }
    },
  })
  const service = serviceFor(home, context)
  try {
    await service.initialize()
    assert.equal((await installFull(service, server.base, 'test-plugin')).status, 'ready')
    server.routes.set('/catalog.json', Buffer.from(JSON.stringify(catalog([item('1.1.0')]))))
    const updated = await wait(service, service.startAction(server.base, 'test-plugin', 'update'))
    assert.equal(updated.status, 'failed')
    assert.match(updated.error, /new version rejected/u)
    assert.equal(service.ledger.get('test-plugin').version, '1.0.0')
    assert.equal(context.bundles.get('test-plugin').version, '1.0.0')
    assert.ok(context.calls.some(call => call.kind === 'installBundle' && call.spec.includes('1.0.0')))
  } finally {
    await service.dispose()
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('semantic version comparison refuses implicit downgrade before any artifact mutation', async () => {
  const home = await tempRoot('capability-center-downgrade-')
  const one = await readFile(await createSkillArchive(
    join(home, 'packages', 'versioned-skill-1.0.0.zip'),
    'versioned-skill',
    '1.0.0',
  ))
  const two = await readFile(await createSkillArchive(
    join(home, 'packages', 'versioned-skill-2.0.0.zip'),
    'versioned-skill',
    '2.0.0',
  ))
  const routes = new Map([
    ['/packages/versioned-skill-1.0.0.zip', one],
    ['/packages/versioned-skill-2.0.0.zip', two],
  ])
  routes.set('/catalog.json', Buffer.from(JSON.stringify(catalog([
    skillItem('versioned-skill', '2.0.0', 'packages/versioned-skill-2.0.0.zip', two),
  ]))))
  const server = await startFileServer(routes)
  const service = serviceFor(home, fakeContext({ skills: runtimeSkills() }))
  try {
    await service.initialize()
    assert.equal((await installFull(service, server.base, 'versioned-skill')).status, 'ready')
    const oldPath = join(home, 'skills', 'versioned-skill', 'scripts', 'info.txt')
    assert.match(await readFile(oldPath, 'utf8'), /2\.0\.0/u)
    routes.set('/catalog.json', Buffer.from(JSON.stringify(catalog([
      skillItem('versioned-skill', '1.0.0', 'packages/versioned-skill-1.0.0.zip', one),
    ]))))
    const downgrade = await wait(service, service.startAction(server.base, 'versioned-skill', 'update'))
    assert.equal(downgrade.status, 'failed')
    assert.match(downgrade.error, /DOWNGRADE_DETECTED|不执行降级/u)
    assert.match(await readFile(oldPath, 'utf8'), /2\.0\.0/u)
  } finally {
    await service.dispose()
    await server.close()
    await rm(home, { recursive: true, force: true })
  }
})

test('actual Python 3.12 isolated venv installs, checks, imports, and uninstalls tabulate', async () => {
  const temp = await tempRoot('capability-center-python-real-')
  const home = join(temp, 'home')
  const runtime = await createVenv(join(temp, 'venv'))
  assert.match(runtime.version, /^3\.12\./u)
  const wheel = await tabulateFixture()
  const item = {
    ...skillItem('python-tabulate', '0.9.0', tabulatePath, wheel, [
      { type: 'python-import', module: 'tabulate', version: '0.9.0' },
      { type: 'python-function', name: 'tabulate-table', module: 'tabulate' },
    ]),
    type: 'python',
    install: { distribution: 'tabulate', module: 'tabulate', wheelTag: 'py3-none-any' },
  }
  const server = await startFileServer([
    ['/catalog.json', catalog([item])],
    [`/${tabulatePath}`, wheel],
  ])
  const service = serviceFor(home, fakeContext({ runtime }))
  try {
    await service.initialize()
    const installed = await installFull(service, server.base, 'python-tabulate')
    assert.equal(installed.status, 'ready', installed.error)
    const probe = await runFile(runtime.python, [
      '-s',
      '-c',
      'import importlib.metadata, tabulate; print(importlib.metadata.version("tabulate")); print(tabulate.tabulate([["能力","状态"]], headers="firstrow", tablefmt="grid"))',
    ])
    assert.match(probe.stdout, /^0\.9\.0/mu)
    assert.match(probe.stdout, /能力/u)
    assert.match(probe.stdout, /状态/u)
    const removed = await wait(service, service.startAction(server.base, 'python-tabulate', 'uninstall'))
    assert.equal(removed.status, 'ready', removed.error)
    await assert.rejects(
      runFile(runtime.python, ['-s', '-c', 'import tabulate']),
      error => /ModuleNotFoundError|No module named/u.test(String(error.stderr)),
    )
  } finally {
    await service.dispose()
    await server.close()
    await rm(temp, { recursive: true, force: true })
  }
})

test('built catalog prompts contain real newlines and no literal backslash-n sequence', async () => {
  const built = await readCatalog()
  let multilinePromptCount = 0
  for (const item of built.items) {
    assert.equal(item.trial.prompt.includes('\\n'), false, item.id)
    if (item.trial.prompt.includes('\n')) multilinePromptCount += 1
  }
  assert.ok(multilinePromptCount >= 1)
})

