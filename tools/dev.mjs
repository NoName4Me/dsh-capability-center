import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import {
  access,
  copyFile,
  cp,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { delimiter, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const devRoot = join(root, '.dev')
const lockPath = join(devRoot, 'dev.lock')
const packagesRoot = join(devRoot, 'packages')
const distributionRoot = join(devRoot, 'distribution')
const defaultDsh = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const prefix = '/capability-center'

function usage() {
  return [
    'Usage: npm run dev -- [options]',
    '',
    'Options:',
    '  --no-open                 Start DSH Web without opening a browser',
    '  --web-port <port>         DSH Web port (default: 4174; 0 selects one)',
    '  --distribution-port <n>   Distribution port (default: 0)',
    '  --dsh <path>              DSH CLI path override',
    '  -h, --help                Show this help',
  ].join('\n')
}

function parsePort(value, label) {
  if (!/^\d+$/u.test(String(value))) throw new Error(`${label} must be an integer from 0 to 65535.`)
  const port = Number(value)
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new Error(`${label} must be an integer from 0 to 65535.`)
  }
  return port
}

function parseArgs(argv) {
  const options = {
    noOpen: false,
    webPort: 4174,
    distributionPort: 0,
    dsh: process.env.CAPABILITY_CENTER_DSH_BIN,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--no-open') {
      options.noOpen = true
      continue
    }
    if (argument === '--help' || argument === '-h') {
      options.help = true
      continue
    }
    if (argument === '--web-port' || argument === '--distribution-port' || argument === '--dsh') {
      const value = argv[index + 1]
      if (value === undefined) throw new Error(`${argument} requires a value.`)
      index += 1
      if (argument === '--web-port') options.webPort = parsePort(value, '--web-port')
      else if (argument === '--distribution-port') options.distributionPort = parsePort(value, '--distribution-port')
      else options.dsh = value
      continue
    }
    throw new Error(`Unknown option: ${argument}`)
  }
  return options
}

async function executable(path) {
  try {
    await access(path, constants.X_OK)
    return resolve(path)
  } catch {
    return undefined
  }
}

async function findOnPath(name) {
  for (const directory of String(process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    const found = await executable(join(directory, name))
    if (found !== undefined) return found
  }
  return undefined
}

async function resolveDsh(explicit) {
  const found = explicit === undefined
    ? await findOnPath('dsh')
    : explicit.includes('/')
      ? await executable(explicit)
      : await findOnPath(explicit)
  if (found !== undefined) return found
  if (explicit === undefined) {
    const bundled = await executable(defaultDsh)
    if (bundled !== undefined) return bundled
  }
  throw new Error([
    '找不到 DSH CLI。',
    '请将 dsh 加入 PATH，或使用 --dsh <path> / CAPABILITY_CENTER_DSH_BIN 指定。',
    `macOS 桌面默认路径：${defaultDsh}`,
  ].join('\n'))
}

function isProcessAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function readLockOwner(path) {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return Number.isSafeInteger(value?.pid) && value.pid > 0 ? value : undefined
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    return undefined
  }
}

export function acquireLock(path = lockPath, pid = process.pid) {
  mkdirSync(dirname(path), { recursive: true })
  let recoveredPid
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let file
    try {
      file = openSync(path, 'wx')
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      const owner = readLockOwner(path)
      if (owner === null) continue
      if (owner === undefined) {
        throw new Error(
          `开发锁内容无法解析：${path}\n如果确认没有 npm run dev 在运行，请删除该文件后重试。`,
        )
      }
      if (isProcessAlive(owner.pid)) {
        throw new Error(`npm run dev 已在运行（PID ${owner.pid}）：${path}`)
      }
      try { unlinkSync(path) } catch {
        continue
      }
      recoveredPid = owner.pid
      continue
    }
    try {
      writeFileSync(file, `${JSON.stringify({ pid, startedAt: new Date().toISOString() })}\n`)
      closeSync(file)
      return { recoveredPid }
    } catch (error) {
      try { closeSync(file) } catch {}
      try { unlinkSync(path) } catch {}
      throw error
    }
  }
  throw new Error(`无法取得开发锁：${path}`)
}

export function releaseLock(path = lockPath, pid = process.pid) {
  const owner = readLockOwner(path)
  if (owner?.pid !== pid) return
  try { unlinkSync(path) } catch {}
}

async function snapshotDistribution() {
  const staging = join(devRoot, `.distribution-${randomUUID()}`)
  await cp(join(root, 'dist'), staging, { recursive: true, errorOnExist: true })
  await rm(distributionRoot, { recursive: true, force: true })
  await rename(staging, distributionRoot)
  return distributionRoot
}

async function contentAddressedBootstrap(version, snapshotRoot) {
  const source = join(snapshotRoot, 'packages', `capability-center-${version}.tgz`)
  const bytes = await readFile(source)
  const hash = createHash('sha256').update(bytes).digest('hex')
  await mkdir(packagesRoot, { recursive: true })
  const target = join(packagesRoot, `capability-center-${version}-${hash.slice(0, 16)}.tgz`)
  await copyFile(source, target)
  return target
}

async function verifyInstalled(home, bootstrapPath) {
  const profileRoot = join(home, 'profiles', 'web')
  const profile = JSON.parse(await readFile(join(profileRoot, 'package.json'), 'utf8'))
  const spec = profile?.dependencies?.['capability-center']
  if (typeof spec !== 'string' || spec !== `file:${bootstrapPath}`) {
    throw new Error(`DSH profile 未切换到本次构建：${String(spec)}`)
  }
  const installedRoot = join(profileRoot, 'node_modules', 'capability-center')
  const comparisons = [
    ['index.js', join(root, 'apps', 'dsh-plugin', 'bootstrap', 'index.js')],
    ['engine-seed/engine/service.js', join(root, 'apps', 'dsh-plugin', 'core', 'service.js')],
  ]
  for (const [relative, expected] of comparisons) {
    const [actualBytes, expectedBytes] = await Promise.all([
      readFile(join(installedRoot, relative)),
      readFile(expected),
    ])
    if (!actualBytes.equals(expectedBytes)) {
      throw new Error(`DSH profile 中的 capability-center/${relative} 仍是旧内容。`)
    }
  }
}

async function workspaceDependenciesOverlay(dsh, home) {
  if (process.platform !== 'darwin') return undefined
  const cli = await realpath(dsh)
  const marker = `${sep}Contents${sep}Resources${sep}runtime${sep}cli${sep}bin${sep}dsh`
  if (!cli.endsWith(marker)) return undefined
  const payload = join(dirname(dirname(dirname(cli))), 'primary-runtime')
  try {
    await access(join(payload, 'runtime.json'), constants.R_OK)
  } catch {
    return undefined
  }
  const patchPath = join(devRoot, 'workspace-dependencies.patch.json')
  const overlay = [{
    insert: [{
      id: 'capability-center-dev-workspace-dependencies',
      name: '@deepseek-ai/dsh-tool-workspace-dependencies',
      config: {
        source: payload,
        root: join(home, 'dsh-runtimes', 'dsh-primary-runtime'),
      },
    }],
  }]
  await writeFile(patchPath, `${JSON.stringify(overlay, null, 2)}\n`, 'utf8')
  return patchPath
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(usage())
    return
  }
  if (process.platform === 'win32') {
    throw new Error('当前 npm run dev 启动器只支持 POSIX shell；Windows 请使用 npm run dev:preview 查看构建。')
  }

  const dsh = await resolveDsh(options.dsh)
  const home = resolve(process.env.CAPABILITY_CENTER_DEV_DSH_HOME || join(devRoot, 'dsh-home'))
  const baseEnv = {
    ...process.env,
    DSH_HOME: home,
    CAPABILITY_CENTER_DEV_SEED: '1',
  }
  const children = new Set()
  const exits = new Map()
  let shutdownPromise
  let shuttingDown = false
  let actualExitCode = 0

  const releaseOwnedLock = () => releaseLock(lockPath, process.pid)

  const spawnTracked = (command, args, options = {}) => {
    if (shuttingDown) throw new Error('开发启动正在关闭。')
    const child = spawn(command, args, {
      cwd: root,
      env: baseEnv,
      stdio: 'inherit',
      ...options,
    })
    children.add(child)
    const exit = new Promise((resolveExit, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) => {
        children.delete(child)
        resolveExit({ code, signal })
      })
    })
    exits.set(child, exit)
    return { child, exit }
  }

  const runChild = async (command, args, options) => {
    const { exit } = spawnTracked(command, args, options)
    const result = await exit
    if (shuttingDown) return result
    if (result.signal !== null) throw new Error(`${command} 被信号 ${result.signal} 终止。`)
    if (result.code !== 0) throw new Error(`${command} ${args.join(' ')} 退出码 ${result.code ?? 1}。`)
    return result
  }

  const stopChild = async child => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    const exit = exits.get(child)
    await Promise.race([
      exit,
      new Promise(resolveTimeout => {
        const timer = setTimeout(resolveTimeout, 3_000)
        timer.unref()
      }),
    ])
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await exit?.catch(() => undefined)
  }

  const shutdown = () => {
    if (shutdownPromise !== undefined) return shutdownPromise
    shuttingDown = true
    shutdownPromise = (async () => {
      await Promise.allSettled([...children].map(stopChild))
    })()
    return shutdownPromise
  }

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.once(signal, () => {
      process.exitCode = signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143
      releaseOwnedLock()
      void shutdown()
    })
  }
  process.once('exit', releaseOwnedLock)

  try {
    const { recoveredPid } = acquireLock(lockPath, process.pid)
    if (recoveredPid !== undefined) {
      console.warn(`已清理上次异常退出留下的开发锁（PID ${recoveredPid}）。`)
    }
    await mkdir(home, { recursive: true })
    await runChild(process.execPath, [join(root, 'build.mjs')])
    if (shuttingDown) return
    const snapshotRoot = await snapshotDistribution()
    if (shuttingDown) return

    const bootstrapVersion = JSON.parse(
      await readFile(join(root, 'apps', 'dsh-plugin', 'bootstrap', 'package.json'), 'utf8'),
    ).version
    const bootstrapPath = await contentAddressedBootstrap(bootstrapVersion, snapshotRoot)
    if (shuttingDown) return

    const python = process.env.CAPABILITY_CENTER_BUILD_PYTHON || 'python3'
    const distribution = spawnTracked(python, [
      '-s',
      'start-server.py',
      '--host',
      '127.0.0.1',
      '--port',
      String(options.distributionPort),
    ], {
      cwd: snapshotRoot,
      env: { ...baseEnv, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let distributionOutput = ''
    const distributionReady = new Promise((resolveReady, reject) => {
      let settled = false
      const fail = error => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(error)
      }
      const finish = url => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolveReady(url)
      }
      const timer = setTimeout(() => {
        distribution.child.kill('SIGTERM')
        fail(new Error(`分发服务未在 10 秒内启动：\n${distributionOutput}`))
      }, 10_000)
      timer.unref()
      distribution.child.stderr.on('data', chunk => {
        distributionOutput = (distributionOutput + chunk.toString()).slice(-64 * 1024)
        process.stderr.write(chunk)
      })
      distribution.child.stdout.on('data', chunk => {
        distributionOutput = (distributionOutput + chunk.toString()).slice(-64 * 1024)
        process.stdout.write(chunk)
        const match = /Distribution URL: (http:\/\/127\.0\.0\.1:\d+\/)/u.exec(distributionOutput)
        if (match) finish(match[1])
      })
      void distribution.exit.then(result => {
        fail(new Error(
          `分发服务提前退出（${result.signal ?? result.code}）：\n${distributionOutput}`,
        ))
      }).catch(fail)
    })
    const distributionUrl = await distributionReady
    if (shuttingDown) return
    const distributionFailure = distribution.exit.then(result => {
      if (!shuttingDown) {
        return Promise.reject(new Error(
          `分发服务意外退出（${result.signal ?? result.code}）：\n${distributionOutput}`,
        ))
      }
      return new Promise(() => {})
    })
    void distributionFailure.catch(() => undefined)
    baseEnv.CAPABILITY_CENTER_DEV_DISTRIBUTION_URL = distributionUrl

    console.log(`Installing ${bootstrapPath}`)
    await Promise.race([
      runChild(dsh, [
        'plugin',
        '--profile',
        'web',
        'add',
        '--offline',
        bootstrapPath,
      ]),
      distributionFailure,
    ])
    if (shuttingDown) return
    await verifyInstalled(home, bootstrapPath)
    if (shuttingDown) return
    const workspacePatch = await workspaceDependenciesOverlay(dsh, home)
    if (shuttingDown) return

    const appArgs = [
      '--profile',
      'web',
      ...(workspacePatch === undefined ? [] : ['--patch', workspacePatch]),
      '--host',
      '127.0.0.1',
      '--port',
      String(options.webPort),
    ]
    if (options.noOpen) appArgs.push('--no-open')
    if (workspacePatch !== undefined) console.log(`Adding workspace dependencies overlay ${workspacePatch}`)
    console.log(
      `Starting DSH Web at http://127.0.0.1:${options.webPort}/; open the sidebar capability center (${prefix}/).`,
    )
    const app = spawnTracked(dsh, appArgs)
    const appResult = await Promise.race([app.exit, distributionFailure])
    if (!shuttingDown && (appResult.signal !== null || appResult.code !== 0)) {
      throw new Error(`DSH Web 退出（${appResult.signal ?? appResult.code}）。`)
    }
    if (!shuttingDown) actualExitCode = appResult.code ?? 0
  } catch (error) {
    if (!shuttingDown) {
      console.error(error instanceof Error ? error.message : error)
      actualExitCode = 1
    }
  } finally {
    await shutdown()
    releaseOwnedLock()
  }
  if (actualExitCode !== 0) process.exitCode = actualExitCode
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
}
