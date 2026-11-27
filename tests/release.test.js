import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import {
  cp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import http from 'node:http'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { readZip } from '../src/engine/lib/archive.js'
import { requestBounded } from '../src/bootstrap/lib/http-transport.js'
import {
  createSkillArchive,
  dist,
  python,
  root,
  sha256,
  tempRoot,
} from './helpers.js'

const runFile = promisify(execFile)

function httpGet(url, method = 'GET') {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks),
      }))
    })
    request.on('error', reject)
    request.end()
  })
}

test('packaged OCR recognizes the bilingual fixture using its local runtime', async () => {
  const temp = await tempRoot('capability-center-ocr-')
  try {
    await runFile(python, [
      '-m', 'tarfile', '-e', join(dist, 'packages', 'capability-center-ocr-0.1.0.tgz'), temp,
    ])
    const bundle = join(temp, 'package')
    const { stdout } = await runFile(process.execPath, [
      join(bundle, 'cli.js'), join(bundle, 'fixture.png'),
    ], { cwd: temp, timeout: 20_000 })
    const result = JSON.parse(stdout)
    assert.match(result.text.replace(/\s+/gu, ''), /离线文字识别OCR2026Invoice12345/u)
    assert.equal(result.page, 1)
    assert.ok(result.words.some(word => word.text === 'Invoice' && word.width > 0 && word.confidence >= 0))
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('offline archive is complete, contains current release metadata, and landing URL is substituted', async () => {
  const archive = readZip(
    await readFile(join(root, 'capability-center-offline.zip')),
    { maxFileBytes: 32 * 1024 * 1024 },
  )
  const names = [...archive.keys()].filter(name => !name.endsWith('/'))
  for (const required of [
    'capability-center/README.md',
    'capability-center/catalog.json',
    'capability-center/core-release-index.json',
    'capability-center/artifact-manifest.json',
    'capability-center/publication-registry.json',
    'capability-center/index.html',
    'capability-center/start-server.py',
    'capability-center/start-server.cmd',
    'capability-center/packages/capability-center-0.2.12.tgz',
    'capability-center/packages/capability-center-drawio-0.1.8.tgz',
    'capability-center/packages/capability-center-ocr-0.1.0.tgz',
    'capability-center/packages/changfenhuang-dsh-genui-0.16.0.tgz',
    'capability-center/packages/dsh-intranet-auto-continue-1.1.0.tgz',
    'capability-center/packages/office-enhancement-skill-1.0.0.zip',
    'capability-center/packages/pypdf-7.1.0-py3-none-any.whl',
    'capability-center/core/capability-center-core-0.2.12.zip',
  ]) {
    assert.ok(names.includes(required), `offline archive is missing ${required}`)
  }
  assert.equal(names.some(name => /(__pycache__|\.pyc$)/u.test(name)), false)
  assert.equal(names.some(name => /capability-center-(?:core-)?0\.2\.1\.(?:zip|tgz)$/u.test(name)), false)
  assert.equal(names.some(name => /report-format|dsh-local-sysinfo|tabulate/u.test(name)), false)
  const catalog = JSON.parse(archive.get('capability-center/catalog.json').toString('utf8'))
  assert.deepEqual(catalog.items.map(item => item.id).sort(), [
    'capability-center-drawio', 'capability-center-ocr', 'dsh-genui', 'dsh-intranet-auto-continue',
    'office-enhancement', 'office-enhancement-skill', 'python-pypdf',
  ])
  const landing = archive.get('capability-center/index.html').toString('utf8')
  assert.doesNotMatch(landing, /\{\{BOOTSTRAP_URL\}\}/u)
  assert.match(landing, /capability-center-0\.2\.12\.tgz/u)
  const manifest = JSON.parse(
    archive.get('capability-center/artifact-manifest.json').toString('utf8'),
  )
  assert.equal(manifest.artifacts.bootstrap.path, 'packages/capability-center-0.2.12.tgz')
  const registry = JSON.parse(archive.get('capability-center/publication-registry.json').toString('utf8'))
  assert.equal(registry.entries['core@0.2.12'].kind, 'core')
  assert.equal(registry.entries['dsh-intranet-auto-continue@1.1.0'].type, 'plugin')
  assert.equal(registry.entries['capability-center-drawio@0.1.8'].type, 'plugin')
  assert.equal(registry.entries['dsh-genui@0.16.0'].type, 'plugin')
  assert.equal(registry.entries['office-enhancement@1.0.0'].type, 'composite')
  assert.equal(registry.entries['python-pypdf@7.1.0'].type, 'python')
})

test('GenUI offline plugin preserves the DSH bundle and excludes registry dependencies', async () => {
  const catalog = JSON.parse(await readFile(join(dist, 'catalog.json'), 'utf8'))
  const item = catalog.items.find(candidate => candidate.id === 'dsh-genui')
  assert.equal(item.install.packageName, '@changfenhuang/dsh-genui')
  const archive = join(dist, item.artifact.path)
  assert.equal(sha256(await readFile(archive)), item.artifact.sha256)
  const { stdout } = await runFile('tar', ['-xOf', archive, 'package/package.json'])
  const manifest = JSON.parse(stdout)
  assert.equal(manifest.name, item.install.packageName)
  assert.equal(manifest.version, item.version)
  for (const field of ['dependencies', 'peerDependencies', 'optionalDependencies', 'scripts', 'packageManager']) {
    assert.equal(manifest[field], undefined)
  }
  const { stdout: entries } = await runFile('tar', ['-tzf', archive])
  const files = new Set(entries.trim().split(/\r?\n/u))
  for (const path of [
    manifest.dsh.bundle.patch, ...Object.values(manifest.exports),
    './lib/assets/mermaid.js', './lib/assets/echarts-full.js', './LICENSE', './THIRD_PARTY_NOTICES.md',
  ]) {
    assert.ok(files.has(`package/${path.replace(/^\.\//u, '')}`), path)
  }
})

test('publisher rejects same-version content changes and accepts a new immutable version', async () => {
  const temp = await tempRoot('capability-center-publisher-')
  const storage = join(temp, 'dist')
  try {
    await cp(dist, storage, { recursive: true })
    const catalogPath = join(storage, 'catalog.json')
    const original = JSON.parse(await readFile(catalogPath, 'utf8'))
    const changedCatalog = structuredClone(original)
    const skill = changedCatalog.items.find(item => item.id === 'office-enhancement-skill')
    const changedBytes = await readFile(await createSkillArchive(
      join(storage, 'packages', 'office-enhancement-skill-1.0.0.zip'),
      'office-enhancement-skill',
      '1.0.0',
      'changed immutable content',
    ))
    skill.artifact.sha256 = sha256(changedBytes)
    skill.artifact.bytes = changedBytes.byteLength
    await writeFile(catalogPath, `${JSON.stringify(changedCatalog, null, 2)}\n`)
    await assert.rejects(
      runFile(process.execPath, [
        join(root, 'tools', 'publish.mjs'),
        'catalog',
        '--storage',
        storage,
        '--catalog',
        catalogPath,
      ]),
      error => /publication-immutable-conflict|已发布过不同内容/u.test(String(error.stderr)),
    )

    const nextBytes = await readFile(await createSkillArchive(
      join(storage, 'packages', 'office-enhancement-skill-1.1.0.zip'),
      'office-enhancement-skill',
      '1.1.0',
    ))
    const next = structuredClone(skill)
    next.version = '1.1.0'
    next.artifact = {
      path: 'packages/office-enhancement-skill-1.1.0.zip',
      sha256: sha256(nextBytes),
      bytes: nextBytes.byteLength,
    }
    await writeFile(catalogPath, `${JSON.stringify({
      schemaVersion: 2,
      name: 'publisher fixture',
      generatedFor: 'dsh-v0.2.1-rc.2',
      items: [next],
    }, null, 2)}\n`)
    const { stdout } = await runFile(process.execPath, [
      join(root, 'tools', 'publish.mjs'),
      'catalog',
      '--storage',
      storage,
      '--catalog',
      catalogPath,
    ])
    assert.match(stdout, /published/u)
    const registry = JSON.parse(await readFile(join(storage, 'publication-registry.json'), 'utf8'))
    assert.ok(registry.entries['office-enhancement-skill@1.0.0'])
    assert.ok(registry.entries['office-enhancement-skill@1.1.0'])
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
})

test('read-only distribution server serves built assets, HEAD, immutable paths, and rejects traversal/writes', async () => {
  const child = spawn(python, [
    '-s',
    'start-server.py',
    '--host',
    '127.0.0.1',
    '--port',
    '0',
  ], {
    cwd: dist,
    env: { ...process.env, PYTHONUNBUFFERED: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  try {
    const base = await new Promise((resolveReady, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`server did not start: ${stdout}\n${stderr}`)),
        8_000,
      )
      child.stdout.on('data', chunk => {
        stdout += chunk
        const match = /Distribution URL: (http:\/\/127\.0\.0\.1:\d+\/)/u.exec(stdout)
        if (match) {
          clearTimeout(timer)
          resolveReady(match[1])
        }
      })
      child.once('exit', code => reject(new Error(`server exited ${code}: ${stdout}\n${stderr}`)))
    })
    const catalog = await httpGet(`${base}catalog.json`)
    assert.equal(catalog.status, 200)
    assert.match(catalog.headers['content-type'], /application\/json/u)
    const initial = /Initial plugin URL: (http:\/\/127\.0\.0\.1:\d+\/packages\/capability-center-0\.2\.12\.tgz)/u
      .exec(stdout)
    assert.ok(initial, `server did not advertise the stable bootstrap:\n${stdout}`)
    assert.doesNotMatch(stdout, /Initial plugin URL: .*capability-center-drawio/u)
    const head = await httpGet(initial[1], 'HEAD')
    assert.equal(head.status, 200)
    assert.ok(Number(head.headers['content-length']) > 10_000)
    assert.match(head.headers['cache-control'], /immutable/u)
    const registry = await httpGet(`${base}publication-registry.json`)
    assert.equal(registry.status, 200)
    const traversal = await httpGet(`${base}%2e%2e/start-server.py`)
    assert.ok([400, 403, 404].includes(traversal.status), String(traversal.status))
    const write = await httpGet(`${base}catalog.json`, 'POST')
    assert.equal(write.status, 405)
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolveExit => {
      if (child.exitCode !== null) resolveExit()
      else child.once('exit', resolveExit)
    })
  }
})

test('Node 24 core HTTP transport completes a 64 KiB close/FIN response without global fetch', async () => {
  const payload = Buffer.alloc(64 * 1024, 0x61)
  const sockets = new Set()
  const server = http.createServer((_req, res) => {
    res.setHeader('content-length', String(payload.byteLength))
    res.setHeader('connection', 'close')
    res.end(payload)
  })
  server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady))
  try {
    const received = await requestBounded(`http://127.0.0.1:${server.address().port}/payload`, {
      maxBytes: 128 * 1024,
      timeoutMs: 5_000,
    })
    assert.equal(received.bytes, payload.byteLength)
    const sources = await Promise.all([
      readFile(join(root, 'src', 'bootstrap', 'lib', 'http-transport.js'), 'utf8'),
      readFile(join(root, 'src', 'engine', 'lib', 'installers.js'), 'utf8'),
    ])
    assert.doesNotMatch(sources.join('\n'), /\bglobalThis\.fetch\b|\bfetch\s*\(/u)
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise(resolveClosed => server.close(resolveClosed))
  }
})

