# DSH 能力中心 0.2.6

面向内网 DSH `0.2.1-rc.2` 至 `0.2.2-rc.2` 的只读能力分发中心。它管理技能、DSH 插件、纯 Python 库和能力包，不要求账号、凭据或模型调用。安装只使用目录声明的本地制品、固定版本和 SHA-256。

当前能力中心版本为 `0.2.6`。核心协议继续使用 `0.2.1-rc.2` 作为兼容标记；实际宿主版本门禁由引导插件和各个插件包的 `engines.dsh` 执行，覆盖文档中的 Win7 `0.2.1-rc.5`、Win10 `0.2.1-rc.2` 以及已测试的 macOS `0.2.2-rc.1`。

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

仅查看页面和目录时可运行 `npm run dev:preview`。它保留原预览行为，默认地址为 [http://127.0.0.1:4173/capability-center/](http://127.0.0.1:4173/capability-center/)，端口可通过 `CAPABILITY_CENTER_PREVIEW_PORT` 指定。

macOS 桌面自带 DSH 没有在官方 Web profile 中启用 `load_workspace_dependencies`。启动器会通过 CLI 的 realpath 识别同一安装内的 `Contents/Resources/runtime/primary-runtime`，在 `.dev/workspace-dependencies.patch.json` 生成仅开发使用的 overlay，并用 `--patch` 挂载 workspace-dependencies。首次使用“Office 增强”时，DSH 会把约 310 MB 的运行时复制到隔离 home 下的 `dsh-runtimes/`，之后复用；应用 bundle 和分发制品不会被修改。其他来源的通用 `dsh` CLI 没有可确认的 primary runtime 时不生成 overlay，此时“Office 增强”的依赖准备不可用，自动续跑不受影响。

当前开发启动器只支持 POSIX shell，并在 macOS 上使用桌面自带 DSH `0.2.2-rc.3` 验证。Windows 内网终端目标版本仍以 [DESIGN.md](DESIGN.md#内网终端环境) 为准，本轮不能在 Win10 `0.2.1-rc.2` 或 Win7 `0.2.1-rc.5` 实机验证 Node/Python 路径、pnpm 离线安装和进程信号行为。

## 离线包内容

`capability-center-offline.zip` 解压后得到完整分发目录 `capability-center/`：

- `packages/capability-center-0.2.6.tgz`：稳定引导插件，也是唯一需要首次通过 DSH“插件 → 添加插件”手动安装的制品。
- `packages/dsh-intranet-auto-continue-1.1.0.tgz`：目录中的“自动续跑”宿主插件，由能力中心安装、更新和卸载。
- `core/capability-center-core-0.2.6.zip`：当前可替换核心，包含可见插件目录、插件运行态检查、隐藏组件过滤、组件直接动作保护和固定 Office 自动检查。
- `packages/office-enhancement-skill-1.0.0.zip`：Office 增强的隐藏技能，只包含固定的 `office_tools.py`、`office_smoke.py`、许可证和 provenance。
- `packages/pypdf-7.1.0-py3-none-any.whl`：官方 PyPI 纯 Python wheel，作为 PDF 隐藏组件。
- `catalog.json`、`core-release-index.json`、`artifact-manifest.json`、`publication-registry.json`：固定目录、核心索引、当前制品清单和发布校验记录。
- `start-server.cmd`、`start-server.py`：只读分发服务。

## 首次安装

1. 将离线包复制到内网 Windows 分发机并解压，进入 `capability-center/`。
2. 双击 `start-server.cmd`。也可运行：

   ```bat
   start-server.cmd --host 0.0.0.0 --port 8765
   ```

3. 在 DSH 中打开“插件 → 添加插件”，粘贴服务打印的 `Initial plugin URL`。
4. 安装并启用 `capability-center-0.2.6.tgz`，根据 DSH 返回结果重启。这是本产品唯一需要手动交给 DSH 安装的插件。
5. 打开侧栏“能力中心”，填写分发基础地址，例如 `http://192.168.1.20:8765/`。

分发服务没有登录、上传接口或写接口。请用防火墙限制到公司内网，并为分发机配置稳定地址。

### 升级现有能力中心

已安装 `0.2.3` 至 `0.2.5` 时不需要重装引导插件。保持分发服务可用，按以下顺序升级：

1. 在“能力中心”填写分发地址，点“检查更新”。
2. 点“下载更新”。在旧版页面中，此按钮叫“准备更新”。
3. 重启 DSH。启动监督器会激活 `0.2.6`，候选启动失败时回退上一健康核心。
4. 重新打开“能力中心”，确认核心为 `v0.2.6`，刷新目录。
5. 打开“自动续跑”卡片。首次使用点击“安装”，已安装旧版则点击“更新”以使用续跑设置和记录。只有 DSH 显示“等待重启”时，才需为插件再重启一次。

从更早版本升级时，顶部核心检查仍独立读取 `core-release-index.json`。即使旧核心因目录检查类型较新而无法显示能力列表，也先准备并重启到 `0.2.6`，再刷新目录。引导过旧且没有核心更新控件时，才需要用 `packages/capability-center-0.2.6.tgz` 人工替换一次。

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
- “试用”只通过 DSH 可信客户端桥新建会话并填入草稿，不会自动发送。
- 顶部“检查更新 / 下载更新”只下载、校验并持久化下一版核心。当前任务继续运行，下一次启动 DSH 时激活；候选启动失败会回退上一健康核心。
- 隐藏组件不在能力目录中显示，也不能被单独安装、检查、试用或卸载。目录仍以平面依赖图表示依赖关系。

## 自动续跑

“自动续跑”由能力中心安装或更新到 `dsh-intranet-auto-continue@1.1.0`。在 DSH「插件 → 自动续跑」打开设置页。

- 「启用自动续跑」是总开关。保存关闭后，已排队的续跑会取消。
- 每项任务默认续跑 **1 次**，可设为 **1–5 次**。只有符合条件的临时中断能触发续跑。用户发新消息后从头计数。
- 「会话暂停」可单独暂停或恢复某个会话。配置保存在当前 DSH profile 中。
- 最近记录保留本次运行的 30 条发送、跳过和取消原因，只显示状态和会话标识，不记录提示词或原始错误正文。DSH 重启后清空。

续跑范围包括超时、传输中断、流提前关闭、空响应、输出达到上限、429 或服务端故障。超过等待上限的限流响应、工具结果不确定、权限限制和原因不明的退出会跳过。待发送期间的新消息、模型或权限变更，以及会话关闭都会取消这次续跑。如果 DSH 显示「等待重启」，重启后插件才会启用。

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
node tools/publish.mjs core --storage dist --archive dist/core/capability-center-core-0.2.6.zip
```

历史离线 ZIP 由 GitHub Releases 按版本保留。作者工具对同一个分发目录以 `publication-registry.json` 校验同版本制品一致性。修改已发布的能力制品时，请提升其版本。

## 已知边界

- 目标桌面为 Windows，但本轮构建和自动检查运行在 macOS DSH Python 3.12；不能声称已完成 Windows 实机验收。
- 首个正式版只接受平面组合：组合的直接子项必须是非组合能力，且子项不能再声明传递依赖。环、缺失依赖和固定版本不一致会被拒绝。
- 插件更新依赖目标 rc.2 宿主 `pluginManager.removeBundle/installBundle` 的真实结果；不同 profile 的 HMR 行为可能返回 `applied` 或 `restart-required`，产品按宿主结果如实显示。
- Python 只接受 `py3-none-any` 纯 Python wheel，不支持 wheel `.data` 安装方案、原生扩展或在线 pip 解析。
- 多文件拆分会在写入前整体检查名称冲突，但运行中的磁盘错误仍可能留下部分已经完成的独立输出；已存在文件绝不会被覆盖。
- 分发服务为无认证只读 HTTP(S) 前端，正式部署应置于受控内网，必要时由现有反向代理终止 HTTPS。

Office 兼容研究记录见 [`docs/research/dsh-builtin-office-rc2.md`](docs/research/dsh-builtin-office-rc2.md)。
