import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { gunzipSync } from 'node:zlib'
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
const target = process.argv[2] === '--target' ? process.argv[3] : undefined
const targets = ['center', 'auto-continue', 'offline-ocr', 'drawio', 'genui', 'office-enhancement']
if (process.argv.length > 2 && (process.argv.length !== 4 || !targets.includes(target))) {
  throw new Error('Usage: node build.mjs [--target '+targets.join('|')+']')
}
const dist = target ? join(root, 'dist-independent', target) : join(root, 'dist')
const packages = join(dist, 'packages')
const coreDirectory = join(dist, 'core')
const work = target ? join(root, '.build-independent', target) : join(root, '.build')
const python = process.env.CAPABILITY_CENTER_BUILD_PYTHON || 'python3'
const { version } = JSON.parse(await readFile(join(root, 'apps', 'dsh-plugin', 'core', 'manifest.json'), 'utf8'))
const offlineArchive = join(root, 'capability-center-offline.zip')

async function configuredFeedbackEmail() {
  let value = String(process.env.CAPABILITY_CENTER_FEEDBACK_EMAIL ?? '').trim()
  if (value === '') {
    try {
      const env = await readFile(join(root, '.env'), 'utf8')
      for (const line of env.split(/\r?\n/u)) {
        const match = /^\s*CAPABILITY_CENTER_FEEDBACK_EMAIL\s*=\s*(.*)\s*$/u.exec(line)
        if (match === null) continue
        value = match[1].replace(/^(['"])(.*)\1$/u, '$2').trim()
        break
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
  if (value === '') return undefined
  if (value.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) {
    throw new Error('CAPABILITY_CENTER_FEEDBACK_EMAIL 不是有效邮箱地址。')
  }
  return value
}

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

function tarFiles(bytes) {
  const archive = gunzipSync(bytes)
  const files = new Map()
  let offset = 0
  while (offset + 512 <= archive.byteLength) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every(byte => byte === 0)) break
    const field = (start, length) => header.subarray(start, start + length)
      .toString('utf8')
      .replace(/\0.*$/u, '')
    const name = field(0, 100)
    const prefix = field(345, 155)
    const path = prefix === '' ? name : `${prefix}/${name}`
    const sizeText = field(124, 12).trim()
    const size = sizeText === '' ? 0 : Number.parseInt(sizeText, 8)
    const type = field(156, 1) || '0'
    if (!Number.isSafeInteger(size) || size < 0) throw new Error(`Invalid tar entry size for ${path}`)
    const bodyStart = offset + 512
    const bodyEnd = bodyStart + size
    if (bodyEnd > archive.byteLength) throw new Error(`Truncated tar entry ${path}`)
    if (type !== '0' && type !== '') throw new Error(`Unsupported tar entry type ${type} for ${path}`)
    files.set(path, archive.subarray(bodyStart, bodyEnd))
    offset = bodyStart + Math.ceil(size / 512) * 512
  }
  return files
}

async function extractDrawio(archivePath, target) {
  const provenance = JSON.parse(await readFile(
    join(root, 'vendor', 'next-ai-drawio-mcp-0.4.15-provenance.json'),
    'utf8',
  ))
  const actual = await sha256(archivePath)
  if (actual !== provenance.archiveSha256) {
    throw new Error(`draw.io vendor archive hash mismatch: ${actual}`)
  }
  const files = tarFiles(await readFile(archivePath))
  const prefix = `${provenance.vendoredPath}/`
  let count = 0
  for (const [path, bytes] of files) {
    if (!path.startsWith(prefix)) continue
    const relative = path.slice(prefix.length)
    if (relative === '' || relative.split('/').some(part => part === '' || part === '..')) {
      throw new Error(`Unsafe draw.io archive path: ${path}`)
    }
    const output = join(target, ...relative.split('/'))
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, bytes)
    count += 1
  }
  if (count === 0) throw new Error('draw.io archive contains no editor files')
  const version = (await readFile(join(target, '.version'), 'utf8')).trim()
  if (version !== provenance.drawioVersion) {
    throw new Error(`draw.io version mismatch: ${version}`)
  }
  await readFile(join(target, 'LICENSE'))
  return { count, provenance }
}

await rm(work, { recursive: true, force: true })
if (!target) await rm(offlineArchive, { force: true })
await mkdir(work, { recursive: true })
await rm(dist, { recursive: true, force: true })
await mkdir(packages, { recursive: true })
await mkdir(coreDirectory, { recursive: true })

async function buildCenter() {
const coreBuild = join(work, 'core-build')
await mkdir(join(coreBuild, 'engine', 'lib'), { recursive: true })
await mkdir(join(coreBuild, 'page'), { recursive: true })
await cp(join(root, 'apps', 'dsh-plugin', 'core', 'manifest.json'), join(coreBuild, 'manifest.json'))
await cp(join(root, 'apps', 'dsh-plugin', 'core', 'package.json'), join(coreBuild, 'package.json'))
await cp(join(root, 'apps', 'dsh-plugin', 'core', 'index.js'), join(coreBuild, 'engine', 'index.js'))
await cp(join(root, 'apps', 'dsh-plugin', 'core', 'service.js'), join(coreBuild, 'engine', 'service.js'))
await cp(join(root, 'apps', 'dsh-plugin', 'core', 'lib'), join(coreBuild, 'engine', 'lib'), { recursive: true })
for (const file of ['index.html', 'styles.css']) {
  await cp(join(root, 'apps', 'dsh-plugin', 'core', 'page', file), join(coreBuild, 'page', file))
}
await cp(join(root, 'apps', 'dsh-plugin', 'bootstrap', 'icon.svg'), join(coreBuild, 'page', 'icon.svg'))
run(process.execPath, [
  join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
  '--project', join(root, 'tsconfig.json'),
  '--outDir', join(coreBuild, 'page'),
])
const coreZip = join(coreDirectory, `capability-center-core-${version}.zip`)
await makeZip(coreBuild, coreZip)

const bootstrapPack = join(work, 'bootstrap')
await cp(join(root, 'apps', 'dsh-plugin', 'bootstrap'), bootstrapPack, { recursive: true })
await cp(coreBuild, join(bootstrapPack, 'engine-seed'), { recursive: true })
const feedbackEmail = await configuredFeedbackEmail()
if (feedbackEmail !== undefined) {
  await writeFile(
    join(bootstrapPack, 'feedback-config.json'),
    `${JSON.stringify({ feedbackEmail }, null, 2)}\n`,
    'utf8',
  )
}
const packedBootstrap = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packages], {
  cwd: bootstrapPack,
}))[0]
if (typeof packedBootstrap?.filename !== 'string') throw new Error('Bootstrap npm pack returned no filename')


return { coreZip, packedBootstrap }
}

async function buildAutoContinue() {
const autoContinueBuild = join(work, 'auto-continue-build')
await cp(
  join(root, 'capabilities', 'auto-continue'),
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


return { autoContinueManifest, packedAutoContinue }
}

async function buildOcr() {
const ocrBuild = join(work, 'ocr-plugin-build')
await cp(join(root, 'capabilities', 'offline-ocr'), ocrBuild, { recursive: true, filter: source => basename(source) !== 'node_modules' })
const ocrManifest = JSON.parse(await readFile(join(ocrBuild, 'package.json'), 'utf8'))
if (!target) {
  // The legacy archive is a different immutable npm release; never publish it under the registry version.
  ocrManifest.version += '-offline.1'
  ocrManifest.bundleDependencies = Object.keys(ocrManifest.dependencies)
}
await writeFile(join(ocrBuild, 'package.json'), JSON.stringify(ocrManifest, null, 2) + '\n')
const ocrProvenancePath = join(root, 'vendor', 'dsh-ocr-runtime-1.0.0-provenance.json')
const ocrProvenance = JSON.parse(await readFile(ocrProvenancePath, 'utf8'))
const ocrRuntime = await readFile(join(root, 'vendor', 'dsh-ocr-runtime-1.0.0.tgz'))
if (createHash('sha256').update(ocrRuntime).digest('hex') !== ocrProvenance.sha256) {
  throw new Error('OCR runtime hash mismatch')
}
for (const [path, bytes] of tarFiles(ocrRuntime)) {
  const parts = path.split('/')
  if (parts[0] !== 'package' || !['node_modules', 'tessdata'].includes(parts[1]) || (target && parts[1] === 'node_modules')) continue
  if (parts.some(part => !part || part === '.' || part === '..' || /[:\\]/u.test(part))) {
    throw new Error(`Invalid OCR runtime path: ${path}`)
  }
  const destination = join(ocrBuild, ...parts.slice(1))
  await mkdir(dirname(destination), { recursive: true })
  await writeFile(destination, bytes)
}
await cp(ocrProvenancePath, join(ocrBuild, 'runtime-provenance.json'))
const [packedOcr] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packages], {
  cwd: ocrBuild,
}))
if (typeof packedOcr?.filename !== 'string') throw new Error('OCR npm pack returned no filename')


return { ocrManifest, packedOcr }
}

async function buildDrawio() {
const drawioPluginBuild = join(work, 'drawio-plugin-build')
await cp(
  join(root, 'capabilities', 'drawio'),
  drawioPluginBuild,
  { recursive: true },
)
const drawioManifest = JSON.parse(await readFile(join(drawioPluginBuild, 'package.json'), 'utf8'))
const drawioAssets = await extractDrawio(
  join(root, 'vendor', 'next-ai-drawio-mcp-0.4.15.tgz'),
  join(drawioPluginBuild, 'drawio'),
)
await cp(
  join(root, 'vendor', 'next-ai-drawio-mcp-0.4.15-provenance.json'),
  join(drawioPluginBuild, 'drawio-provenance.json'),
)
const packedDrawio = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', packages], {
  cwd: drawioPluginBuild,
}))[0]
if (typeof packedDrawio?.filename !== 'string') {
  throw new Error('draw.io plugin npm pack returned no filename')
}
if (drawioAssets.count < 2_000) {
  throw new Error(`draw.io editor extraction is incomplete: ${drawioAssets.count} files`)
}


return { drawioManifest, packedDrawio }
}

async function buildGenui() {
const genuiProvenanceFile = 'dsh-genui-0.16.0-provenance.json'
const genuiProvenanceBytes = await readFile(join(root, 'vendor', genuiProvenanceFile))
const genuiProvenance = JSON.parse(genuiProvenanceBytes)
const genuiArchive = join(root, 'vendor', genuiProvenance.archive)
if (await sha256(genuiArchive) !== genuiProvenance.archiveSha256) {
  throw new Error('GenUI vendor archive hash mismatch')
}
const genuiFiles = tarFiles(await readFile(genuiArchive))
const genuiUpstream = JSON.parse(genuiFiles.get('package/package.json'))
if (genuiUpstream.name !== genuiProvenance.package || genuiUpstream.version !== genuiProvenance.version) {
  throw new Error('GenUI vendor package identity mismatch')
}
const genuiBuild = join(work, 'genui-build')
const genuiRuntimeFiles = [
  'lib/index.js', 'lib/client.js',
  'lib/assets/echarts-core.js', 'lib/assets/echarts-full.js', 'lib/assets/icons.js',
  'lib/assets/maplibre.js', 'lib/assets/mermaid.js', 'lib/assets/standalone-runtime.js', 'lib/assets/three.js',
  'assets/genui-icon.svg', 'assets/genui-logo.svg', 'cordis.patch.yml', 'SKILL.md',
  'docs/copy-preview.md', 'docs/dsh-go.md', 'docs/gallery.md', 'docs/map.md',
  'README.md', 'README.zh-CN.md', 'ICON-NAMES.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md',
]
for (const file of genuiRuntimeFiles) {
  const bytes = genuiFiles.get(`package/${file}`)
  if (bytes === undefined) throw new Error(`GenUI archive is missing ${file}`)
  const target = join(genuiBuild, file)
  await mkdir(dirname(target), { recursive: true })
  await writeFile(target, bytes)
}
const genuiManifest = {
  name: genuiUpstream.name,
  version: genuiUpstream.version,
  description: genuiUpstream.description,
  license: genuiUpstream.license,
  type: genuiUpstream.type,
  main: genuiUpstream.main,
  icon: genuiUpstream.icon,
  exports: {
    '.': './lib/index.js',
    './client': './lib/client.js',
    './package.json': './package.json',
    './icon': './assets/genui-icon.svg',
    './skill': './SKILL.md',
    './assets/standalone': './lib/assets/standalone-runtime.js',
    './assets/maplibre': './lib/assets/maplibre.js',
  },
  engines: { dsh: genuiUpstream.engines.dsh, node: genuiUpstream.engines.node },
  dsh: genuiUpstream.dsh,
  dshGo: genuiUpstream.dshGo,
  files: [...genuiRuntimeFiles, genuiProvenanceFile],
}
await writeFile(join(genuiBuild, genuiProvenanceFile), genuiProvenanceBytes)
await writeFile(join(genuiBuild, 'package.json'), JSON.stringify(genuiManifest, null, 2) + '\n')
const [packedGenui] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', packages], {
  cwd: genuiBuild,
}))
if (typeof packedGenui?.filename !== 'string') throw new Error('GenUI npm pack returned no filename')


return { genuiManifest, packedGenui }
}

async function buildOffice() {
const officeSkillSource = join(root, 'capabilities', 'office-enhancement')
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


return { officeSkillZip, officeSkillRoot, officeSkillBuild }
}

if (target) {
  const builders = {'center':buildCenter,'auto-continue':buildAutoContinue,'offline-ocr':buildOcr,'drawio':buildDrawio,'genui':buildGenui,'office-enhancement':buildOffice}
  const result = await builders[target]()
  if (target === 'center') {
    await writeFile(join(dist, 'core-release-index.json'), JSON.stringify({schemaVersion:1,name:'能力中心核心版本',protocolVersion:1,targetDsh:'dsh-v0.2.1-rc.2',releases:[]},null,2)+'\n')
    run(process.execPath,[join(root,'tools','publish.mjs'),'core','--storage',dist,'--archive',result.coreZip])
  }
  if (target === 'office-enhancement') {
    const id='office-enhancement'
    const skillRoot=join(work,'registry-skill',id)
    await cp(result.officeSkillRoot,skillRoot,{recursive:true})
    let skill=await readFile(join(skillRoot,'SKILL.md'),'utf8')
    skill=skill.replace('name: office-enhancement-skill','name: office-enhancement')
      .replace('先调用 `load_workspace_dependencies` 获取 DSH 返回的 `python` 与 `pythonPackages`。所有 Python 命令都必须使用该解释器','本能力脚本必须使用技能末尾注明的独立 Python 解释器（下文变量 DSH_PYTHON 指该解释器）。调用 DSH 原生渲染、导出、重算技能时另按宿主说明获取原生运行时')
      .replace('这里要求的是能力中心核心 `v0.2.2` 或更高，不是 DSH 本身 `v0.2.2`。旧能力中心核心应先更新并重启，否则目录会因缺少固定自动检查而按设计拒绝加载。','安装前要求能力中心 0.3.0，独立环境继承 DSH 内置 Office 库。')
    await writeFile(join(skillRoot,'SKILL.md'),skill)
    const rawDir=join(dist,'skills',id,'1.1.0');await mkdir(rawDir,{recursive:true})
    const zip=join(rawDir,'skill.zip');await makeZip(join(work,'registry-skill'),zip)
    const wheel=await artifact(join(packages,'pypdf-7.1.0-py3-none-any.whl'))
    const a=await artifact(zip)
    const descriptor={id,type:'skill',name:'Office 增强',version:'1.1.0',description:'PDF、Word、Excel、PPT 本地增强，复用 DSH 原生 Office 运行时。',compatibility:{dsh:'0.2.1-rc.2',python:'>=3.11.0 <3.13.0',os:['win32','darwin','linux'],arch:['x64','arm64']},artifact:{path:'skills/office-enhancement/1.1.0/skill.zip',bytes:a.bytes,sha256:a.sha256},runtime:{python:{inheritBuiltin:true,requirements:[{name:'pypdf',version:'7.1.0',hashes:[wheel.sha256]}]}},checks:[{type:'python-import',module:'pypdf',version:'7.1.0'},{type:'python-import',module:'docx'},{type:'python-import',module:'openpyxl'},{type:'python-import',module:'pptx'},{type:'python-import',module:'pandas'}],usage:{steps:['安装并检查独立 Python 环境。','在对话中使用 office-enhancement 技能；原生 Office 导出、渲染与重算按宿主说明执行。'],inputs:'本地 PDF、DOCX、XLSX、PPTX',output:'新文件及操作摘要',example:'使用独立环境合并两个本地 PDF。'},trial:{prompt:'请使用 office-enhancement 技能，使用该技能标注的独立 Python 执行 scripts/office_smoke.py，并如实报告检查结果。'}}
    await writeFile(join(rawDir,'capability.json'),JSON.stringify(descriptor,null,2)+'\n')
  }
  await rm(work,{recursive:true,force:true})
  console.log('独立构建完成: '+dist)
  process.exit(0)
}

const { coreZip, packedBootstrap } = await buildCenter()
const { autoContinueManifest, packedAutoContinue } = await buildAutoContinue()
const { ocrManifest, packedOcr } = await buildOcr()
const { drawioManifest, packedDrawio } = await buildDrawio()
const { genuiManifest, packedGenui } = await buildGenui()
const { officeSkillZip } = await buildOffice()

const artifacts = {
  bootstrap: await artifact(join(packages, packedBootstrap.filename)),
  autoContinue: await artifact(join(packages, packedAutoContinue.filename)),
  ocr: await artifact(join(packages, packedOcr.filename)),
  drawio: await artifact(join(packages, packedDrawio.filename)),
  genui: await artifact(join(packages, packedGenui.filename)),
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
          '如果状态显示“刷新生效”，请刷新页面；只有宿主明确要求重启时才重启 DSH。',
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
      id: 'capability-center-drawio',
      type: 'plugin',
      name: 'draw.io 画布',
      version: drawioManifest.version,
      description: '在原生会话左侧持续显示同源离线 draw.io，右侧复用原聊天和输入框；模型可按选区 ID 更新原图，支持样式与结构编辑。',
      compatibility: {
        os: ['win32', 'darwin', 'linux'],
        arch: ['x64', 'arm64'],
        dsh: '0.2.1-rc.2',
      },
      artifact: {
        path: artifacts.drawio.path,
        sha256: artifacts.drawio.sha256,
        bytes: artifacts.drawio.bytes,
      },
      dependencies: [],
      install: { packageName: 'capability-center-drawio' },
      checks: [{ type: 'plugin-bundle' }],
      usage: {
        steps: [
          '安装后在对话中让模型调用 drawio_create 创建画板。',
          '创建时自动进入画布。左侧使用中文编辑器，右侧继续使用原会话和输入框。',
          '完成后点击回复下方卡片的“打开画布”重开该图，也可从会话头部进入当前画布。',
          '框选图元后在右侧直接描述样式或流程变更。',
          '框选后可直接在右侧输入并发送；宿主会先等待精确选区写入，再通过 plugin context 把绑定的画板、revision 和图元 ID 交给模型。',
          '需要独立文件时，在画布顶部点击“导出 .drawio”；服务端持久化仍是 DSH_HOME 下的原子 JSON 记录。',
        ],
        inputs: '节点的稳定 ID、标签、坐标、尺寸和样式，连线端点，以及 draw.io 当前选区。',
        output: '会话绑定的同源 draw.io 画板、修订号、精确选区与原子更新结果。',
        example: '框选两个节点并输入“把这两个改蓝，并把第三步移到它们之间”，模型读取选区后更新样式和连线。',
      },
      trial: {
        prompt: 'draw.io 画布是宿主插件。安装并重启 DSH 后，在普通对话中让模型创建一张包含三个步骤的流程图，再通过消息卡片进入画布检查。不要建议公网 draw.io 或联网加载资源。',
      },
    },
    {
      id: ocrManifest.name,
      type: 'plugin',
      name: '离线文字识别',
      version: ocrManifest.version,
      description: '在本机 CPU 上识别图片和扫描 PDF 的简体中文及英文印刷文字。',
      compatibility: { os: ['win32', 'darwin'], arch: ['x64', 'arm64'], dsh: '0.2.1-rc.2' },
      artifact: artifacts.ocr,
      dependencies: [],
      install: { packageName: ocrManifest.name },
      checks: [{ type: 'plugin-bundle' }, { type: 'named-tool-readonly-call', tool: 'offline_ocr_check' }],
      usage: {
        steps: ['安装后在 DSH 对话中选择或提供本地文件，让模型使用 offline-ocr 技能。', '扫描 PDF 使用宿主的 Office 渲染技能逐页处理，可指定页码。'],
        inputs: 'PNG、JPEG 或宿主可渲染的 PDF 页面，支持简体中文和英文印刷文字。',
        output: 'UTF-8 纯文本，或含页码、词级坐标和 OCR 置信度的 JSON。',
        example: '请用离线文字识别读取这张截图，并把识别结果存为 UTF-8 文本。',
      },
      trial: { prompt: '请用 offline-ocr 技能识别我指定的本地图片。如果我还没提供文件，请先提示我添加一张 PNG 或 JPEG。' },
    },
    {
      id: 'dsh-genui',
      type: 'plugin',
      name: 'GenUI 交互式回复',
      version: genuiManifest.version,
      description: '在 DSH 回复中显示可交互的图表、表格和表单。此版本供内网试用，Win10 和 Win7 桌面端待实机验收。',
      compatibility: {
        os: ['win32', 'darwin'],
        arch: ['x64', 'arm64'],
        dsh: '0.2.1-rc.2 || 0.2.1-rc.5 || 0.2.1-rc.5-win7 || 0.2.2-rc.3',
      },
      artifact: artifacts.genui,
      dependencies: [],
      install: { packageName: genuiManifest.name },
      checks: [{ type: 'plugin-bundle' }],
      usage: {
        steps: [
          '从能力中心安装。若提示“刷新生效”，请刷新页面；只有宿主明确要求重启时才重启 DSH。',
          '在新对话中让模型用 GenUI 展示表格、图表或表单。',
          '图表可用会话中的数据本地渲染。内网试用请使用本地媒体，地图默认没有街道底图。',
        ],
        inputs: '会话中的数据和需要用户选择或填写的项目。',
        output: '回复内的交互组件。点击表单提交后，选择结果回到当前会话。',
        example: '用虚构数据画一张三个月销量图，再给我一个选择月份的表单。',
      },
      trial: {
        prompt: '请用 GenUI 在回复中展示一张三个月销量趋势图，使用虚构数据。再给我一个选择月份并提交的表单。请只使用本地组件，不加载任何外部资源。',
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
