import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const runFile = promisify(execFile)

export const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const dist = join(root, 'dist')
export const python = process.env.CAPABILITY_CENTER_TEST_PYTHON
  || '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/python/bin/python3.12'

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

export async function tempRoot(prefix = 'capability-center-test-') {
  return await mkdtemp(join(tmpdir(), prefix))
}

export async function readCatalog(path = join(dist, 'catalog.json')) {
  return JSON.parse(await readFile(path, 'utf8'))
}

export async function createZip(target, entries) {
  await mkdir(dirname(target), { recursive: true })
  await runFile(python, ['-c', [
    'import json, pathlib, sys, zipfile',
    'target = pathlib.Path(sys.argv[1])',
    'entries = json.loads(sys.argv[2])',
    'target.unlink(missing_ok=True)',
    'with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:',
    '  for name, text in entries.items():',
    '    archive.writestr(name, text)',
  ].join('\n'), target, JSON.stringify(entries)], {
    timeout: 30_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  return target
}

export async function createSkillArchive(target, id, version, body = `version ${version}`) {
  return await createZip(target, {
    [`${id}/SKILL.md`]: `---\nname: ${id}\ndescription: Test skill ${version}\n---\n\n# ${id}\n\n${body}\n`,
    [`${id}/scripts/info.txt`]: `${id} ${version}\n`,
  })
}

export async function startFileServer(initial = new Map()) {
  const routes = initial instanceof Map ? initial : new Map(initial)
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname
    const value = routes.get(path)
    if (value === undefined) {
      res.statusCode = 404
      res.end()
      return
    }
    const body = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value))
    res.statusCode = 200
    res.setHeader('content-length', String(body.byteLength))
    res.setHeader('content-type', path.endsWith('.json')
      ? 'application/json; charset=utf-8'
      : 'application/octet-stream')
    res.end(body)
  })
  await new Promise(resolveReady => server.listen(0, '127.0.0.1', resolveReady))
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}/`,
    routes,
    async addFile(from, to) {
      routes.set(to, await readFile(from))
    },
    async close() {
      server.closeAllConnections?.()
      await new Promise(resolveClosed => server.close(resolveClosed))
    },
  }
}

export async function distributionServer() {
  const files = new Map([
    ['/catalog.json', await readFile(join(dist, 'catalog.json'))],
  ])
  for (const item of (await readCatalog()).items) {
    if (item.artifact !== undefined) {
      files.set(`/${item.artifact.path}`, await readFile(join(dist, item.artifact.path)))
    }
  }
  return await startFileServer(files)
}

export function runtimeSkills({ ready = true } = {}) {
  const current = new Map()
  const registrations = []
  return {
    registrations,
    register(definition) {
      registrations.push(definition)
      current.set(definition.name, definition)
      return () => {
        if (current.get(definition.name) === definition) current.delete(definition.name)
      }
    },
    async get(name) {
      return ready ? current.get(name) : undefined
    },
  }
}

export function fakeContext(options = {}) {
  const calls = []
  const bundles = new Map(options.bundles ?? [])
  const context = {
    skills: options.skills ?? runtimeSkills(),
    tools: {
      async execute(request) {
        calls.push({ kind: 'tool', request })
        if (request.name === 'load_workspace_dependencies') {
          if (options.runtime === undefined) {
            return { isError: true, error: { code: 'fixture' }, content: [{ type: 'text', text: 'missing' }] }
          }
          return {
            isError: false,
            value: options.runtime,
            content: [{ type: 'text', text: JSON.stringify(options.runtime) }],
          }
        }
        if (options.toolResult !== undefined) return await options.toolResult(request)
        return { isError: true, error: { code: 'fixture-tool' }, content: [{ type: 'text', text: 'missing' }] }
      },
    },
    pluginManager: {
      async listBundles() {
        return [...bundles.values()].map(value => ({ ...value }))
      },
      async listPlugins() {
        return options.listPlugins === undefined
          ? []
          : await options.listPlugins(bundles)
      },
      async installBundle(spec, installOptions) {
        calls.push({ kind: 'installBundle', spec, installOptions })
        const result = await options.installBundle?.(spec, installOptions, bundles)
          ?? { application: 'applied', changed: true, stage: 'install', target: options.bundleName }
        if (result?.application === 'applied' && options.bundleName) {
          bundles.set(options.bundleName, {
            name: options.bundleName,
            installed: true,
            enabled: true,
            version: basename(spec).match(/\d+\.\d+\.\d+/u)?.[0],
          })
        }
        return result
      },
      async removeBundle(name) {
        calls.push({ kind: 'removeBundle', name })
        const result = await options.removeBundle?.(name, bundles)
          ?? { application: 'applied', changed: true, stage: 'remove', target: name }
        if (result?.application === 'applied' && options.keepBundleAfterRemove !== true) {
          bundles.delete(name)
        }
        return result
      },
    },
    bundles,
    calls,
  }
  return context
}

export async function createVenv(directory, { systemSitePackages = false } = {}) {
  const args = ['-m', 'venv']
  if (systemSitePackages) args.push('--system-site-packages')
  args.push(directory)
  await runFile(python, args, {
    timeout: 60_000,
    maxBuffer: 2 * 1024 * 1024,
  })
  const executable = join(directory, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  const { stdout } = await runFile(executable, [
    '-c',
    'import json, sys, sysconfig; print(json.dumps({"version":"%d.%d.%d" % sys.version_info[:3],"pythonPackages":sysconfig.get_paths()["purelib"]}))',
  ])
  const value = JSON.parse(stdout)
  return { python: executable, pythonPackages: value.pythonPackages, version: value.version }
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

export function skillItem(id, version, artifactPath, bytes, checks = [{ type: 'skill-discovery', name: id }]) {
  return {
    id,
    type: 'skill',
    name: `技能 ${id}`,
    version,
    description: `测试技能 ${id}`,
    compatibility: {
      os: ['win32', 'darwin', 'linux'],
      arch: ['x64', 'arm64'],
      dsh: '0.2.1-rc.2',
    },
    artifact: { path: artifactPath, sha256: sha256(bytes), bytes: bytes.byteLength },
    dependencies: [],
    checks,
    usage: {
      steps: ['安装。', '试用。'],
      inputs: '测试输入。',
      output: '测试输出。',
      example: '运行测试。',
    },
    trial: { prompt: `测试 ${id}\n第二行` },
  }
}

export function flatComposite(id, dependencies, name = id) {
  return {
    id,
    type: 'composite',
    name,
    version: '1.0.0',
    description: `组合 ${id}`,
    compatibility: {
      os: ['win32', 'darwin', 'linux'],
      arch: ['x64', 'arm64'],
      dsh: '0.2.1-rc.2',
    },
    dependencies,
    checks: [{ type: 'skill-discovery', name: dependencies[0].id }],
    usage: {
      steps: ['安装组合。', '分别使用子能力。'],
      inputs: '无。',
      output: '子能力。',
      example: '安装。',
    },
    trial: { prompt: '介绍这个组合中的能力。\n不要自动发送。' },
  }
}

export function catalog(items, name = 'fixture catalog') {
  return {
    schemaVersion: 2,
    name,
    generatedFor: 'dsh-v0.2.1-rc.2',
    items,
  }
}

export function successfulTool(request) {
  return {
    isError: false,
    value: { tool: request.name },
    content: [{ type: 'text', text: `${request.name}:ok` }],
  }
}

