import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import {
  cp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url))
const dist = join(root, 'dist')
const packages = join(dist, 'packages')
const coreDirectory = join(dist, 'core')
const work = join(root, '.build')
const python = process.env.CAPABILITY_CENTER_BUILD_PYTHON || 'python3'
const { version } = JSON.parse(await readFile(join(root, 'src', 'engine', 'manifest.json'), 'utf8'))
const offlineArchive = join(root, 'capability-center-offline.zip')

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    ...options,
  })
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout || ''}\n${result.stderr || ''}`)
  }
  return result.stdout
}

async function artifact(path) {
  const bytes = await readFile(path)
  return {
    path,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  }
}

async function makeZip(source, target) {
  run(python, ['-c', [
    'import pathlib, sys, zipfile',
    'source = pathlib.Path(sys.argv[1])',
    'target = pathlib.Path(sys.argv[2])',
    'target.unlink(missing_ok=True)',
    'with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:',
    '  for path in sorted(source.rglob("*"), key=lambda value: value.as_posix()):',
    '    if path.is_file():',
    '      info = zipfile.ZipInfo(path.relative_to(source).as_posix(), (1980, 1, 1, 0, 0, 0))',
    '      info.compress_type = zipfile.ZIP_DEFLATED',
    '      info.external_attr = (path.stat().st_mode & 0o777) << 16',
    '      archive.writestr(info, path.read_bytes())',
  ].join('\n'), source, target])
}

async function sha256(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

await rm(work, { recursive: true, force: true })
await rm(offlineArchive, { force: true })
await mkdir(work, { recursive: true })
await rm(dist, { recursive: true, force: true })
await mkdir(packages, { recursive: true })
await mkdir(coreDirectory, { recursive: true })

const coreBuild = join(work, 'core-build')
await mkdir(join(coreBuild, 'engine', 'lib'), { recursive: true })
await mkdir(join(coreBuild, 'page'), { recursive: true })
await cp(join(root, 'src', 'engine', 'manifest.json'), join(coreBuild, 'manifest.json'))
await cp(join(root, 'src', 'engine', 'package.json'), join(coreBuild, 'package.json'))
await cp(join(root, 'src', 'engine', 'index.js'), join(coreBuild, 'engine', 'index.js'))
await cp(join(root, 'src', 'engine', 'service.js'), join(coreBuild, 'engine', 'service.js'))
await cp(join(root, 'src', 'engine', 'lib'), join(coreBuild, 'engine', 'lib'), { recursive: true })
for (const file of ['index.html', 'styles.css']) {
  await cp(join(root, 'src', 'engine', 'page', file), join(coreBuild, 'page', file))
}
run(process.execPath, [
  join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
  '--project', join(root, 'tsconfig.json'),
  '--outDir', join(coreBuild, 'page'),
])
const coreZip = join(coreDirectory, `capability-center-core-${version}.zip`)
await makeZip(coreBuild, coreZip)

const bootstrapPack = join(work, 'bootstrap')
await cp(join(root, 'src', 'bootstrap'), bootstrapPack, { recursive: true })
await cp(coreBuild, join(bootstrapPack, 'engine-seed'), { recursive: true })
const packedBootstrap = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packages], {
  cwd: bootstrapPack,
}))[0]
if (typeof packedBootstrap?.filename !== 'string') throw new Error('Bootstrap npm pack returned no filename')

const autoContinueBuild = join(work, 'auto-continue-build')
await cp(
  join(root, 'src', 'capabilities', 'dsh-intranet-auto-continue'),
  autoContinueBuild,
  { recursive: true },
)
const autoContinueManifest = JSON.parse(await readFile(join(autoContinueBuild, 'package.json'), 'utf8'))
const packedAutoContinue = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packages], {
  cwd: autoContinueBuild,
}))[0]
if (typeof packedAutoContinue?.filename !== 'string') {
  throw new Error('Auto-continue npm pack returned no filename')
}

const officeSkillSource = join(root, 'src', 'capabilities', 'office-enhancement')
const officeSkillBuild = join(work, 'office-skill-build')
const officeSkillRoot = join(officeSkillBuild, 'office-enhancement-skill')
await mkdir(join(officeSkillRoot, 'scripts'), { recursive: true })
await mkdir(join(officeSkillRoot, 'licenses'), { recursive: true })
await mkdir(join(officeSkillRoot, 'provenance'), { recursive: true })
await cp(join(officeSkillSource, 'SKILL.md'), join(officeSkillRoot, 'SKILL.md'))
await cp(join(officeSkillSource, 'LICENSE'), join(officeSkillRoot, 'LICENSE'))
await cp(
  join(officeSkillSource, 'scripts', 'office_tools.py'),
  join(officeSkillRoot, 'scripts', 'office_tools.py'),
)
await cp(
  join(officeSkillSource, 'scripts', 'office_smoke.py'),
  join(officeSkillRoot, 'scripts', 'office_smoke.py'),
)
await cp(
  join(root, 'vendor', 'pypdf-LICENSE'),
  join(officeSkillRoot, 'licenses', 'pypdf-LICENSE.txt'),
)
await cp(
  join(root, 'vendor', 'pypdf-7.1.0-provenance.json'),
  join(officeSkillRoot, 'provenance', 'pypdf-7.1.0.json'),
)
const officeSkillZip = join(packages, 'office-enhancement-skill-1.0.0.zip')
await makeZip(officeSkillBuild, officeSkillZip)
await cp(
  join(root, 'vendor', 'pypdf-7.1.0-py3-none-any.whl'),
  join(packages, 'pypdf-7.1.0-py3-none-any.whl'),
)

const artifacts = {
  bootstrap: await artifact(join(packages, packedBootstrap.filename)),
  autoContinue: await artifact(join(packages, packedAutoContinue.filename)),
  officeSkill: await artifact(officeSkillZip),
  pypdf: await artifact(join(packages, 'pypdf-7.1.0-py3-none-any.whl')),
  core: await artifact(coreZip),
}
for (const value of Object.values(artifacts)) value.path = value.path.slice(dist.length + 1).replaceAll('\\', '/')

const catalog = {
  schemaVersion: 2,
  name: 'DSH rc.2 内网能力目录',
  generatedFor: 'dsh-v0.2.1-rc.2',
  items: [
    {
      id: 'dsh-intranet-auto-continue',
      type: 'plugin',
      name: '自动续跑',
      version: autoContinueManifest.version,
      description: '遇到可恢复的中断时自动续跑。默认 1 次，可在 DSH 插件页设置次数、暂停会话并查看记录。',
      compatibility: {
        os: ['win32', 'darwin', 'linux'],
        arch: ['x64', 'arm64'],
      },
      artifact: {
        path: artifacts.autoContinue.path,
        sha256: artifacts.autoContinue.sha256,
        bytes: artifacts.autoContinue.bytes,
      },
      dependencies: [],
      install: { packageName: 'dsh-intranet-auto-continue' },
      checks: [{ type: 'plugin-bundle' }],
      usage: {
        steps: [
          '点击“安装”后，DSH 会启用插件。',
          '如果状态显示“等待重启”，请重启 DSH。',
          '在 DSH“插件 → 自动续跑”中调整次数或查看记录。',
        ],
        inputs: '安装后新产生的人类输入与 DSH 回合事件。',
        output: '遇到符合条件的失败时，按设置的次数上限自动追加续跑消息。',
        example: '安装并重启后正常运行任务；遇到超时或传输中断时，插件按宿主事件决定是否追加一次续跑。',
      },
      trial: {
        prompt: '自动续跑是宿主插件，不会通过试用自动发送消息或触发续跑。请查看本条目说明，并在需要时手动点击“安装”。',
      },
    },
    {
      id: 'office-enhancement-skill',
      type: 'skill',
      name: 'Office 增强技能',
      version: '1.0.0',
      description: 'office-enhancement 的隐藏技能组件，提供固定 PDF、Word、Excel、PowerPoint 本地脚本与自动检查。',
      hidden: true,
      compatibility: {
        os: ['win32', 'darwin', 'linux'],
        arch: ['x64', 'arm64'],
        dsh: '0.2.1-rc.2',
        python: '>=3.11.0 <3.13.0',
      },
      artifact: {
        path: 'packages/office-enhancement-skill-1.0.0.zip',
        sha256: artifacts.officeSkill.sha256,
        bytes: artifacts.officeSkill.bytes,
      },
      dependencies: [],
      checks: [{ type: 'skill-discovery', name: 'office-enhancement-skill' }],
      usage: {
        steps: ['由 office-enhancement 统一安装。', '不能单独安装或卸载。'],
        inputs: '由 office-enhancement 使用的本地 Office 文件。',
        output: '固定脚本与自动检查资源。',
        example: '通过 office-enhancement 使用。',
      },
      trial: { prompt: 'Office 增强技能是隐藏组件，请使用 office-enhancement。' },
    },
    {
      id: 'python-pypdf',
      type: 'python',
      name: 'pypdf',
      version: '7.1.0',
      description: 'PyPI 官方 pypdf 7.1.0 纯 Python wheel，作为 office-enhancement 的隐藏 PDF 组件。',
      hidden: true,
      compatibility: {
        os: ['win32', 'darwin', 'linux'],
        arch: ['x64', 'arm64'],
        dsh: '0.2.1-rc.2',
        python: '>=3.11.0 <3.13.0',
      },
      artifact: {
        path: 'packages/pypdf-7.1.0-py3-none-any.whl',
        sha256: artifacts.pypdf.sha256,
        bytes: artifacts.pypdf.bytes,
      },
      dependencies: [],
      install: {
        distribution: 'pypdf',
        module: 'pypdf',
        wheelTag: 'py3-none-any',
      },
      checks: [{ type: 'python-import', module: 'pypdf', version: '7.1.0' }],
      usage: {
        steps: ['由 office-enhancement 统一安装。', '已有同版本可信安装时只借用。'],
        inputs: 'PDF 文件。',
        output: 'PDF 页面与文本操作能力。',
        example: '通过 office-enhancement 合并 PDF。',
      },
      trial: { prompt: 'pypdf 是隐藏组件，请使用 office-enhancement。' },
    },
    {
      id: 'office-enhancement',
      type: 'composite',
      name: 'Office 增强',
      version: '1.0.0',
      description: '常用 PDF、Word、Excel、PPT 本地增强，复用 DSH 内置 Office 运行时，并提供原生导出、渲染和公式重算入口。',
      compatibility: {
        os: ['win32', 'darwin', 'linux'],
        arch: ['x64', 'arm64'],
        dsh: '0.2.1-rc.2',
        python: '>=3.11.0 <3.13.0',
      },
      dependencies: [
        { id: 'office-enhancement-skill', version: '1.0.0' },
        { id: 'python-pypdf', version: '7.1.0' },
      ],
      checks: [{ type: 'office-smoke' }],
      usage: {
        steps: [
          '先确认能力中心核心已升级到 v0.2.2 并重启 DSH。',
          '安装后通过固定自动检查核对 DSH Python 中的 Office 库和真实文件操作。',
          '按任务调用技能内固定脚本；导出 PDF、渲染和重算继续使用 DSH 原生 Office 技能。',
          '输入保持不变，所有输出写入新的本地路径；脚本会拒绝冲突和覆盖。',
        ],
        inputs: '本地 PDF、DOCX、XLSX、PPTX、JSON 占位数据及本地图片。',
        output: '新的 PDF、DOCX、XLSX、PPTX 或文本文件，以及可复核的本地操作摘要。',
        example: '用 Word 模板填充表格和页眉页脚，用 pypdf 抽取 PDF 页码 1,3-5，再用 DSH 原生技能导出 PDF。',
      },
      trial: {
        prompt: `请调用 load_workspace_dependencies 获取 DSH Python，然后使用已注册的 office-enhancement-skill 运行其固定 scripts/office_smoke.py。

本次试用无附件。脚本只创建并删除系统临时目录中的合成 PDF、DOCX、XLSX、PPTX 和单像素图片夹具，执行 PDF 合并/抽页/旋转/文本提取、Word 正文与表格/页眉/页脚填充、Excel 去重/按 key 比较/合并/拆表、PPT 文本与图片替换。

请报告实际 Python 路径、python-docx/openpyxl/python-pptx/pandas/pypdf 版本和脚本返回的真实页数、差异行数、幻灯片数。不得修改工作区或用户文件，不得声称未执行的操作成功。最后各给一个如何将该技能应用到用户文件的简短示例。`,
      },
    },
  ],
}
await writeFile(join(dist, 'catalog.json'), `${JSON.stringify(catalog, null, 2)}\n`, 'utf8')

const releaseIndex = {
  schemaVersion: 1,
  name: '能力中心核心版本',
  protocolVersion: 1,
  targetDsh: 'dsh-v0.2.1-rc.2',
  releases: [],
}
await writeFile(join(dist, 'core-release-index.json'), `${JSON.stringify(releaseIndex, null, 2)}\n`, 'utf8')
await writeFile(join(dist, 'artifact-manifest.json'), `${JSON.stringify({
  catalogSha256: await sha256(join(dist, 'catalog.json')),
  coreReleaseIndexSha256: await sha256(join(dist, 'core-release-index.json')),
  artifacts,
}, null, 2)}\n`, 'utf8')

const landingTemplate = await readFile(join(root, 'server', 'index.html'), 'utf8')
const bootstrapUrl = `/packages/${packedBootstrap.filename}`
if (!landingTemplate.includes('{{BOOTSTRAP_URL}}')) {
  throw new Error('server/index.html must contain the {{BOOTSTRAP_URL}} placeholder')
}
await writeFile(
  join(dist, 'index.html'),
  landingTemplate.replace('{{BOOTSTRAP_URL}}', bootstrapUrl),
  'utf8',
)
run(process.execPath, [
  join(root, 'tools', 'publish.mjs'),
  'catalog',
  '--storage',
  dist,
  '--catalog',
  join(dist, 'catalog.json'),
])
run(process.execPath, [
  join(root, 'tools', 'publish.mjs'),
  'core',
  '--storage',
  dist,
  '--archive',
  coreZip,
])
const publishedManifest = JSON.parse(await readFile(join(dist, 'artifact-manifest.json'), 'utf8'))
publishedManifest.catalogSha256 = await sha256(join(dist, 'catalog.json'))
publishedManifest.coreReleaseIndexSha256 = await sha256(join(dist, 'core-release-index.json'))
publishedManifest.publicationRegistrySha256 = await sha256(join(dist, 'publication-registry.json'))
await writeFile(
  join(dist, 'artifact-manifest.json'),
  `${JSON.stringify(publishedManifest, null, 2)}\n`,
  'utf8',
)

await cp(join(root, 'server', 'start-server.py'), join(dist, 'start-server.py'))
await cp(join(root, 'server', 'start-server.cmd'), join(dist, 'start-server.cmd'))
await cp(join(root, 'README.md'), join(dist, 'README.md'))

const offlineRoot = join(work, 'offline', 'capability-center')
await mkdir(offlineRoot, { recursive: true })
await cp(dist, offlineRoot, { recursive: true })
await makeZip(join(work, 'offline'), offlineArchive)
await rm(work, { recursive: true, force: true })

const output = {
  dist,
  offlineArchive: await artifact(offlineArchive),
  artifacts,
  bootstrapUrl,
}
console.log(JSON.stringify(output, null, 2))
