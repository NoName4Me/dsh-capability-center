# DSH 能力中心 0.2.12

> 正在规划私服版与 monorepo 迁移。本文仍为当前 0.2.12 的安装使用说明；下一阶段见[目标架构](docs/architecture/target-design.md)、[私服联调](docs/development/registry-integration.md)、[迁移计划](docs/development/migration-plan.md)。

面向内网 DSH `0.2.1-rc.2` 至 `0.2.2-rc.2` 的能力分发中心。它管理技能、DSH 插件、真实注册的 MCP 能力和能力包，不要求账号、凭据或模型调用。隐藏依赖中的纯 Python wheel 仍由本机账本管理，但不再作为顶部目录分类。安装只使用目录声明的本地制品、固定版本和 SHA-256。

当前能力中心版本为 `0.2.12`。核心协议继续使用 `0.2.1-rc.2` 作为兼容标记；实际宿主版本门禁由引导插件和各个插件包的 `engines.dsh` 执行，覆盖文档中的 Win7 `0.2.1-rc.5`、Win10 `0.2.1-rc.2` 以及已验证的 macOS Web `0.2.2-rc.3` 基线。

[项目文档索引](docs/README.md)

## 本地开发

在源码仓库根目录运行以下命令。需要 Node.js 22 或更新版本、PATH 中的 `python3`，以及 DSH CLI `0.2.2-rc.3`。也可以用 `CAPABILITY_CENTER_BUILD_PYTHON` 指定构建用的 Python。

```sh
npm ci
npm run dev
```

`npm run dev` 会先取得开发锁，再重新构建能力中心，把完整分发目录快照到 `.dev/distribution`，从该快照在本机 `127.0.0.1` 随机端口启动真实的 `start-server.py`，将本次构建的 bootstrap TGZ 以内容哈希文件名离线安装到隔离的 `.dev/dsh-home` web profile，然后启动官方 Web DSH。运行中的实例不读取共享 `dist/`，因此之后执行 `npm test`、`npm run build` 或 `npm run dev:preview` 不会替换其目录。默认 Web 根地址是 [http://127.0.0.1:4174/](http://127.0.0.1:4174/)；DSH 默认会打开带认证的根地址。进入 Web DSH 后，从侧栏打开“能力中心”。不要直接打开 `/capability-center/` 的 iframe 地址，未经过 DSH 根页面认证时该地址会返回 401。

随机分发端口会在每次启动时写入当前构建页面的开发专用 meta，因此首次访问和新构建重启后都会自动预填地址。DSH 根页面负责认证，能力中心的同源 iframe 负责页面和试用草稿桥。

开发运行使用 `.dev/dsh-home` 持久保存 web profile、插件和安装记录，该目录已加入 `.gitignore`。开发锁阻止同一仓库并发启动两个 `npm run dev`。DSH 退出、启动失败、分发服务退出或按 Ctrl+C 时，启动器会等待构建、安装和 Web 子进程结束并清理分发子进程与开发锁，下一次启动会重新安装当前构建。进程被强制终止留下 `.dev/dev.lock` 时，下次启动会检查其中记录的 PID，自动清理已退出进程的旧锁。

常用参数如下。参数放在 `--` 后，例如 `npm run dev -- --no-open --web-port 4180`。

```sh
npm run dev -- --no-open
npm run dev -- --web-port 4180
npm run dev -- --web-port 0
npm run dev -- --distribution-port 8765
npm run dev -- --dsh /path/to/dsh
```

DSH 查找顺序是 `--dsh`、`CAPABILITY_CENTER_DSH_BIN`、PATH 中的 `dsh`，最后是 macOS 桌面路径 `/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`。可用 `CAPABILITY_CENTER_DEV_DSH_HOME` 覆盖隔离 home，但同一仓库仍只允许一个开发实例。

页面交互源码位于 [app.ts](src/engine/page/app.ts)。`npm run typecheck` 运行 TypeScript 严格类型检查，构建时会编译出 DSH 加载的 `page/app.js`。

仅查看页面和目录时可运行 `npm run dev:preview`。它保留原预览行为，默认地址为 [http://127.0.0.1:4173/capability-center/](http://127.0.0.1:4173/capability-center/)，端口可通过 `CAPABILITY_CENTER_PREVIEW_PORT` 指定。预览和构建都会读取 `CAPABILITY_CENTER_FEEDBACK_EMAIL`；未设置进程环境变量时，本地构建读取被 git 忽略的 `.env`。

macOS 桌面自带 DSH 没有在官方 Web profile 中启用 `load_workspace_dependencies`。启动器会通过 CLI 的 realpath 识别同一安装内的 `Contents/Resources/runtime/primary-runtime`，在 `.dev/workspace-dependencies.patch.json` 生成仅开发使用的 overlay，并用 `--patch` 挂载 workspace-dependencies。首次使用“Office 增强”时，DSH 会把约 310 MB 的运行时复制到隔离 home 下的 `dsh-runtimes/`，之后复用；应用 bundle 和分发制品不会被修改。其他来源的通用 `dsh` CLI 没有可确认的 primary runtime 时不生成 overlay，此时“Office 增强”的依赖准备不可用，自动续跑不受影响。

当前开发启动器只支持 POSIX shell，并在 macOS 上使用桌面自带 DSH `0.2.2-rc.3` 验证。Windows 内网终端目标版本仍以 [DESIGN.md](DESIGN.md#内网终端环境) 为准，本轮不能在 Win10 `0.2.1-rc.2` 或 Win7 `0.2.1-rc.5` 实机验证 Node/Python 路径、pnpm 离线安装和进程信号行为。

## 离线文字识别

在能力中心安装「离线文字识别」，在 DSH 对话中提供本地 PNG、JPEG 或 PDF，让模型使用 `offline-ocr` 技能。图片由随包引擎在本机识别，扫描 PDF 由 DSH 的 `office-render` 技能渲染后逐页识别。也可使用 DSH 随包 Node 直接运行插件内的 `cli.js <图片路径> [json|text]`。识别引擎本身无需网络，DSH 对话的联网行为取决于模型配置。两套 Windows 目标环境仍需实机验收。 [调研与验收清单](docs/research/dsh-offline-ocr.md)

## 离线包内容

`capability-center-offline.zip` 解压后得到完整分发目录 `capability-center/`：

- `packages/capability-center-0.2.12.tgz`：稳定引导插件，也是唯一需要首次通过 DSH“插件 → 添加插件”手动安装的制品。
- `packages/dsh-intranet-auto-continue-1.1.0.tgz`：目录中的“自动续跑”宿主插件，由能力中心安装、更新和卸载。
- `packages/changfenhuang-dsh-genui-0.16.0.tgz`：目录中的“GenUI 交互式回复”试用插件。构建读取固定的上游制品，保留预编译运行文件和许可声明，目标机安装从内网分发包取件。
- `packages/capability-center-ocr-0.1.0.tgz`：离线文字识别插件，随包提供简中、英文模型、WASM 和运行依赖。
- `core/capability-center-core-0.2.12.zip`：当前可替换核心，包含可见插件目录、真实 MCP 可选标注、热切换与失败回退、更新红点、反馈配置、插件运行态检查、隐藏组件过滤和固定 Office 自动检查。
- `packages/office-enhancement-skill-1.0.0.zip`：Office 增强的隐藏技能，只包含固定的 `office_tools.py`、`office_smoke.py`、许可证和 provenance。
- `packages/pypdf-7.1.0-py3-none-any.whl`：官方 PyPI 纯 Python wheel，作为 PDF 隐藏组件。
- `catalog.json`、`core-release-index.json`、`artifact-manifest.json`、`publication-registry.json`：固定目录、核心索引、当前制品清单和发布校验记录。
- `start-server.cmd`、`start-server.py`：只读分发服务。

已有 `0.2.8` 的终端可直接更新核心。侧栏需要先安装 `0.2.12` 引导。之后侧栏会在刷新后读取当前核心的图标。

### GenUI 实机验收

使用空的测试 profile 和 pnpm 缓存，阻断公网并保留内网分发服务与测试模型的连通性。分别在 Win10 x64 DSH `0.2.1-rc.2` 和 Win7 x64 DSH `0.2.1-rc.5-win7` 上从能力中心安装。按提示重启，确认目录显示已激活，再用“去使用”草稿检查消息内的图表渲染、表单回传，以及同一轮先校验再生成回复是否报错。最后从能力中心卸载，确认重新启动后不再渲染 GenUI。记录实际宿主版本和各项结果。外链媒体依赖相应的网络，地图默认无街道底图。

## 首次安装

1. 将离线包复制到内网 Windows 分发机并解压，进入 `capability-center/`。
2. 双击 `start-server.cmd`。也可运行：

   ```bat
   start-server.cmd --host 0.0.0.0 --port 8765
   ```

3. 在 DSH 中打开“插件 → 添加插件”，粘贴服务打印的 `Initial plugin URL`。
4. 安装并启用 `capability-center-0.2.12.tgz`，根据 DSH 返回结果重启。这是本产品唯一需要手动交给 DSH 安装的插件。
5. 打开侧栏“能力中心”，填写分发基础地址，例如 `http://192.168.1.20:8765/`。

分发服务没有登录、上传接口或写接口。请用防火墙限制到公司内网，并为分发机配置稳定地址。

### 升级现有能力中心

已安装 `0.2.3` 至 `0.2.7` 时可以继续使用现有引导插件，按以下顺序升级：

1. 在“能力中心”填写分发地址，点“检查更新”。
2. 点“下载更新”。在旧版页面中，此按钮叫“准备更新”。
3. 使用 `0.2.8` 或更新的引导时，点击“刷新生效”。监督器会停止旧核心的新操作、等待队列完成、启动并校验候选核心；成功后刷新 DSH 顶层页面。候选失败时隔离候选并恢复旧核心，不会显示成功 toast。
4. 仍由旧引导运行时，可下载核心后在下次 DSH 启动中激活，保留旧 bootstrap 的自然启动路径。需要后续热切换时，再从 DSH 插件页替换为 `capability-center-0.2.12.tgz`。
5. 重新打开“能力中心”，确认核心为 `v0.2.12`。普通插件返回 `applied` 且运行态为 `active` 时只显示“刷新页面生效”；宿主要求重启时，支持原生重启的桌面端会显示“重启 DSH”。其他宿主会提示退出并重新打开。

从更早版本升级时，顶部核心检查仍独立读取 `core-release-index.json`。即使旧核心因目录检查类型较新而无法显示能力列表，也先准备并重启到 `0.2.12`，再刷新目录。引导过旧且没有核心更新控件时，才需要用 `packages/capability-center-0.2.12.tgz` 人工替换一次。新版 bootstrap 自带较高 seed 时，只会在没有更高 pending、且同版 seed 未被隔离失败时自动提级；旧 bootstrap 仍按持久 `pending` 在自然启动中生效。

### 管理已下架的示例能力

自 `0.2.3` 起，新目录和离线包已移除报告格式、本机系统信息、Tabulate 及其入门组合。原有受管安装仍可通过本机账本查看、检查和卸载。

### 从旧管理器迁移

旧管理器包名是 `capability-center-demo`，新稳定包名是 `capability-center`。首次迁移时，在 DSH 插件页停用并移除旧管理器一次，但保留它安装的报告格式、本机系统信息和 Tabulate，也不要先删除 DSH 配置。此后核心更新不需要卸载 `capability-center`。

- 旧版技能和 Python 库凭原安装回执迁入本机账本，可离线检查、诊断和由能力中心卸载。
- 旧版仅存在于 DSH profile 的插件只做识别、检查和试用，不由能力中心接管或卸载。请到“DSH 插件页”管理这类插件。
- 由本版能力中心新安装的插件进入账本，支持检查、修复和安全卸载。

## 使用

- 卡片显示安装状态，并提供安装、更新、卸载和适用的试用入口。点击卡片主体查看详情和“检查与修复”。
- 安装完成后自动执行目录声明的有界检查。离线时仍可读取本机账本、诊断和卸载已安装能力。
- “去使用”只通过 DSH 可信客户端桥新建会话并填入草稿，不会自动发送。
- 顶部“检查更新 / 下载更新”只下载、校验并持久化候选核心。“刷新生效”会串行停止旧核心、等待操作队列、确认新核心健康并刷新 DSH 顶层页面；候选启动或健康校验失败时回退旧核心。旧 bootstrap 不具备热切换能力时，候选仍在下次 DSH 启动中兼容激活。
- 普通插件由宿主返回 `applied` 且运行态确认 `active` 后显示“刷新页面生效”。能力中心通过可信 iframe 桥请求 DSH 刷新顶层页面，并使用 `shell.overlay` 显示一次成功提示；只有真实 `restart-required` 才显示重启 DSH。
- 侧栏图标右上角红点只在已安装的可见项目录版本严格更高、核心有真实更新或存在已暂存核心时显示。客户端每 15 分钟、重新联网、页面恢复可见及本机设置变化时检查；离线模式不读取远端，失败或普通版本相同不会点亮。
- 顶部“MCP”只匹配目录条目明确声明 `category: "mcp"` 且由 DSH 插件真实注册的 MCP。当前 Draw.io 是 DSH 原生工具，不计作 MCP；Python 只作为 Office 等能力的隐藏依赖存在。
- 隐藏组件不在能力目录中显示，也不能被单独安装、检查、试用或卸载。目录仍以平面依赖图表示依赖关系。

## 自动续跑

“自动续跑”由能力中心安装或更新到 `dsh-intranet-auto-continue@1.1.0`。在 DSH「插件 → 自动续跑」打开设置页。

- 「启用自动续跑」是总开关。保存关闭后，已排队的续跑会取消。
- 每项任务默认续跑 **1 次**，可设为 **1–5 次**。只有符合条件的临时中断能触发续跑。用户发新消息后从头计数。
- 「会话暂停」可单独暂停或恢复某个会话。配置保存在当前 DSH profile 中。
- 最近记录保留本次运行的 30 条发送、跳过和取消原因，只显示状态和会话标识，不记录提示词或原始错误正文。DSH 重启后清空。

续跑范围包括超时、传输中断、流提前关闭、空响应、输出达到上限、429 或服务端故障。超过等待上限的限流响应、工具结果不确定、权限限制和原因不明的退出会跳过。待发送期间的新消息、模型或权限变更，以及会话关闭都会取消这次续跑。如果宿主明确返回“等待重启”，重启后插件才会启用；若已返回 `applied` 且运行态为 `active`，只刷新页面。

## Office 增强

“Office 增强”是一个可见能力包，内部固定引用隐藏技能 `office-enhancement-skill@1.0.0` 和隐藏包 `python-pypdf@7.1.0`。它复用 DSH Python 中的 `python-docx 1.2.0`、`openpyxl 3.1.5`、`python-pptx 1.0.2`、`pandas 3.0.1`，并要求 Python `>=3.11 <3.13`。兼容目标为 DSH `0.2.1-rc.2`。

安装后的自动检查会读取真实 DSH Python，校验固定版本，并在系统临时目录创建合成文件，实际执行 PDF、DOCX、XLSX 和 PPTX 操作。全程使用安装包内哈希固定的 `office_smoke.py` 和 `office_tools.py`，从目录执行任意 shell 脚本的路径不存在。详细技能说明见 [`src/capabilities/office-enhancement/SKILL.md`](src/capabilities/office-enhancement/SKILL.md)；安装后的技能目录由 DSH 技能注册表显示为 `office-enhancement-skill`。

Office 工具只处理本地文件，不调用 WPS。输入保持只读，每条命令都要求新的输出路径，并拒绝覆盖已存在文件、符号链接、模板、数据 JSON、图片或其他输入。支持的操作如下：

| 类型 | 操作 |
| --- | --- |
| PDF | 合并、逐页拆分、抽取指定页、旋转指定页、提取文字层 |
| Word | 用 UTF-8 JSON 填充 `{{key}}`，包括正文、表格、页眉和页脚中的普通 run；普通查找替换 |
| Excel | 多文件合并、按 key 比较、按 key 去重、按工作表拆分 |
| PowerPoint | 在现有幻灯片中替换文本占位符和图片占位符，保留其他可编辑对象 |
| DSH 原生流程 | 使用 DSH Python 和内置 Office 技能完成导出 PDF、页面/工作表渲染、公式重算 |

Word 和 PowerPoint 的零替换会直接失败；仍有未解析占位符时返回 `partial`，不能当作全部完成。PDF 加密文件、扫描件 OCR、Word 复杂域/修订/内容控件、Excel 宏、PPT 动画/SmartArt 和复杂组合仍需按文档限制处理。

Office 脚本要求先通过 `load_workspace_dependencies` 获得 `$DSH_PYTHON`。`$OFFICE_SKILL` 表示 DSH 技能注册表中 `office-enhancement-skill` 的实际目录。Windows 桌面使用以下 PowerShell 形式：

```powershell
& $DSH_PYTHON -s "$OFFICE_SKILL/scripts/office_tools.py" docx fill --template template.docx --output filled.docx --data values.json
& $DSH_PYTHON -s "$OFFICE_SKILL/scripts/office_tools.py" pdf extract-pages --input input.pdf --output picked.pdf --pages 1,3-5
& $DSH_PYTHON -s "$OFFICE_SKILL/scripts/office_tools.py" excel compare-by-key --left old.xlsx --right new.xlsx --output diff.xlsx --keys id --mode values
& $DSH_PYTHON -s "$OFFICE_SKILL/scripts/office_tools.py" pptx fill --template template.pptx --output filled.pptx --data slide-values.json
```

POSIX 环境使用以下形式，解释器和技能路径都必须加引号，以支持带空格的 DSH 安装路径：

```sh
"$DSH_PYTHON" -s "$OFFICE_SKILL/scripts/office_tools.py" docx fill --template template.docx --output filled.docx --data values.json
"$DSH_PYTHON" -s "$OFFICE_SKILL/scripts/office_tools.py" pdf merge --output merged.pdf a.pdf b.pdf
"$DSH_PYTHON" -s "$OFFICE_SKILL/scripts/office_tools.py" excel dedupe --input input.xlsx --output deduped.xlsx --keys id --mode values
"$DSH_PYTHON" -s "$OFFICE_SKILL/scripts/office_tools.py" excel split-sheets --input input.xlsx --output-dir sheets/ --mode formulas
```

Excel 的 `--mode values` 读取公式缓存并写成普通值，不负责计算；`--mode formulas` 只保留实际公式单元格，并把普通字符串 `=...` 保持为文本。合并和去重会移动公式行，必须显式增加 `--allow-formula-shift`，之后使用 DSH 原生重算并读取真实结果。`compare-by-key` 报告把公式写成文本，避免报告本身执行公式。

pypdf 固定为官方 PyPI `pypdf-7.1.0-py3-none-any.whl`，SHA-256 为 `47cca6b24bdcf4c4d65b5f7b8b972535c61710a061261e737688777cfd9a7bfb`，共 `418698` 字节。许可证和来源记录在技能包的 `licenses/`、`provenance/`。若 DSH Python 已有经过官方 wheel 文件摘要、发行版元数据、唯一 `find_spec().origin` 和包文件逐项校验的同版 pypdf，能力中心只登记 borrowed 引用，不覆盖、不删除、不写 `.pth`；最后一个组合卸载时只移除账本引用。同版受管子组件可在制品端点暂时不可用时复用已完成校验的本地安装。版本不匹配、模块被遮蔽或文件损坏会在任何技能、账本或注册表变更前拒绝。

## 反馈

页面右下角保留独立反馈入口，不与滚动内容重叠。点击后通过 `mailto:` 在系统默认邮件客户端打开草稿。Windows 终端如已将 Coremail 注册并设为 `MAILTO` 的默认应用，草稿会在 Coremail 中打开；草稿使用 CRLF 换行，并预填问题或需求类型、能力及版本、Win7/Win10、DSH 版本、复现步骤、实际与期望结果以及截图说明。截图需要用户在邮件客户端中手动添加为附件。

反馈邮件地址通过 `CAPABILITY_CENTER_FEEDBACK_EMAIL` 注入。构建时优先读取显式进程环境变量，其次读取被 git 忽略的仓库根 `.env`；生成包只包含被忽略的分发制品配置。运行 DSH 时也可直接设置同名环境变量覆盖包配置。`npm run dev:preview` 使用相同来源。仓库中的 tracked 文件不保存邮箱地址，构建日志也不打印该值。

Windows 7 桌面宿主会拦截顶层外链，因此这里不调用 `window.open`，也不使用 `_blank`/`_top`。普通 mailto 草稿及 Outlook CRLF 行为仍需在 Win7 `0.2.1-rc.5-win7` 和 Win10 `0.2.1-rc.2` 实机确认。

## 更新与回滚

能力更新先下载并校验全部制品。技能和 Python 库在失败时回滚；插件先持久化回滚意图和旧版 TGZ，再调用宿主 `pluginManager`。无法证明恢复成功时，账本会保留恢复日志并阻止进一步变更。

核心与引导插件分开：核心可频繁更新，常驻的稳定引导只在协议升级时人工替换。原子账本、操作意图日志和回滚备份位于 `DSH_HOME/capability-center/`，不要手工删除其中的 `operations/` 或 `rollback/`。

## 发布

在 GitHub 的 **Actions → 打包并发布离线 ZIP → Run workflow** 手动启动。构建和测试通过后，工作流读取 `package.json` 中的版本，在对应的 `vX.Y.Z` Release 上传 `capability-center-offline.zip` 和 SHA-256 校验文件。已使用的版本标签会停止发布，发布新内容前请提升版本。普通推送和 PR 不会触发该流程。

在完整源码工作区中构建。构建根据源码和固定离线依赖生成当前版本的核心、引导插件和能力制品，先验证目录图与制品哈希，再以固定 ZIP 时间戳生成离线包。新核心和 Office 技能 ZIP 使用排序路径、固定时间戳和固定权限位，重复构建应得到相同摘要。

```sh
npm ci
CAPABILITY_CENTER_BUILD_PYTHON=/path/to/python3 npm run build
```

作者侧 CLI 必须从源码工程 `capability-center/` 根目录运行，因为源码工程包含 `tools/` 和 `src/`。发布完成后，将更新后的 `dist/` 目录整体复制到内网分发机；离线 ZIP 只包含分发目录的内容，不包含作者侧工具。

```sh
node tools/publish.mjs catalog --storage dist --catalog dist/catalog.json
node tools/publish.mjs core --storage dist --archive dist/core/capability-center-core-0.2.12.zip
```

历史离线 ZIP 由 GitHub Releases 按版本保留。作者工具对同一个分发目录以 `publication-registry.json` 校验同版本制品一致性。修改已发布的能力制品时，请提升其版本。

## 已知边界

- macOS DSH Web `0.2.2-rc.3` 已完成自动续跑安装后顶层刷新与全局 toast、夹具更新及红点消失、核心 `0.2.7 → 0.2.8` 热切换与全局 toast、`0.2.9` 故障夹具回退和 feedback 模板/布局检查。Windows 7/10 仍需分别按目标 DSH 实机验收。
- DSH 顶层刷新不会保留能力中心 panel，因此刷新前先在 `sessionStorage` 写入结构化待刷新事实，刷新后通过 `shell.overlay` 显示全局 toast；toast 只在目标插件或核心的 auth 状态接口确认目标版本已 `ready` 后出现。旧宿主没有槽时，能力中心页在 claim 超时后用 `/api/refresh-state` 做一次性降级提示。
- 当前 Draw.io 画布由 DSH 原生注册工具和静态上游资产组成，不是 MCP。目录的 MCP 分类是可选字段，只供未来真正随 DSH 插件注册 MCP 的条目使用。
- 目标桌面为 Windows，但本轮构建和自动检查运行在 macOS DSH Python 3.12；不能声称已完成 Windows 实机验收。
- 首个正式版只接受平面组合：组合的直接子项必须是非组合能力，且子项不能再声明传递依赖。环、缺失依赖和固定版本不一致会被拒绝。
- 插件更新依赖目标 rc.2 宿主 `pluginManager.removeBundle/installBundle` 的真实结果；不同 profile 的 HMR 行为可能返回 `applied` 或 `restart-required`，产品按宿主结果如实显示。
- Python 只接受 `py3-none-any` 纯 Python wheel，不支持 wheel `.data` 安装方案、原生扩展或在线 pip 解析。
- 多文件拆分会在写入前整体检查名称冲突，但运行中的磁盘错误仍可能留下部分已经完成的独立输出；已存在文件绝不会被覆盖。
- 分发服务为无认证只读 HTTP(S) 前端，正式部署应置于受控内网，必要时由现有反向代理终止 HTTPS。

Office 兼容研究记录见 [`docs/research/dsh-builtin-office-rc2.md`](docs/research/dsh-builtin-office-rc2.md)。
