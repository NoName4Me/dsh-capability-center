# DSH 能力中心 0.2.3

面向 DSH `0.2.1-rc.2` 的只读内网能力分发中心。它管理技能、DSH 插件、纯 Python 库和平面组合能力，不要求账号、凭据或模型调用。安装只使用目录声明的本地制品、固定版本和 SHA-256。

当前能力中心版本为 `0.2.3`，目标宿主为 DSH `0.2.1-rc.2`。

[项目文档索引](docs/README.md)

## 本地预览 UI

在源码仓库根目录运行以下命令。需要 Node.js 22 或更新版本，以及 PATH 中的 `python3`。也可以用 `CAPABILITY_CENTER_BUILD_PYTHON` 指定构建用的 Python。

```sh
npm ci
npm run dev
```

打开 [能力中心本地预览](http://127.0.0.1:4173/capability-center/)。预览使用当前构建的真实页面和目录，可以搜索、筛选和查看详情。修改源码后，按 Ctrl+C 停止，再运行 `npm run dev`。端口可通过 `CAPABILITY_CENTER_PREVIEW_PORT` 指定。

页面交互源码位于 [app.ts](src/engine/page/app.ts)。`npm run typecheck` 运行 TypeScript 严格类型检查，构建时会编译出 DSH 加载的 `page/app.js`。

需要实际安装、卸载、试用或检查核心更新时，在预览构建完成后，另开终端运行：

```sh
python3 dist/start-server.py --host 127.0.0.1 --port 8765
```

首次使用时，在 DSH 的“插件 → 添加插件”粘贴终端打印的 `Initial plugin URL`，启用插件并按提示重启。在 DSH 侧栏打开“能力中心”，填入 `http://127.0.0.1:8765/` 并刷新。已安装稳定引导插件时，也可在页面检查并准备新核心，重启 DSH 后生效。

## 离线包内容

`capability-center-offline.zip` 解压后得到完整分发目录 `capability-center/`：

- `packages/capability-center-0.2.3.tgz`：稳定引导插件，首次通过 DSH“插件 → 添加插件”安装。
- `core/capability-center-core-0.2.3.zip`：当前可替换核心，包含隐藏组件过滤、组件直接动作保护和固定 Office 自动检查。
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
4. 安装并启用 `capability-center-0.2.3.tgz`，根据 DSH 返回结果重启。
5. 打开侧栏“能力中心”，填写分发基础地址，例如 `http://192.168.1.20:8765/`。

分发服务没有登录、上传接口或写接口。请用防火墙限制到公司内网，并为分发机配置稳定地址。

### 从能力中心 0.2.1 升级

从 `0.2.2` 开始，目录包含固定的 `office-smoke` 检查。`0.2.1` 核心会按设计拒绝加载这个新目录，因此旧页面的能力列表暂时无法打开；这是 fail-closed，避免旧核心跳过 Office 固定检查、所有权借用或回滚逻辑后仍安装能力。

旧核心仍可独立读取 `core-release-index.json` 并更新自身，不需要先打开目录。按以下顺序升级：

1. 保持 `0.2.1` 页面和分发服务可用，在“能力中心”中填写分发地址。
2. 点“检查更新”。即使能力目录显示校验失败，顶部核心检查仍会读取独立的核心发布索引。
3. 点“准备更新”。确认提示显示“核心 v0.2.3 已准备更新”；这一步只下载、校验并持久化核心，不打断当前任务。
4. 重启 DSH。启动监督器会激活 `0.2.3`；启动失败时会回退上一健康核心。
5. 重新打开“能力中心”，确认核心为 `v0.2.3`，再刷新目录并按需安装“Office 增强”。

稳定的 `capability-center` 引导插件无需随本次核心更新替换。若环境中的引导过旧、没有核心更新控件，可直接在 DSH“插件 → 添加插件”安装 `packages/capability-center-0.2.3.tgz`，再启动分发服务。

### 管理已下架的示例能力

自 `0.2.3` 起，新目录和离线包已移除报告格式、本机系统信息、Tabulate 及其入门组合。原有受管安装仍可通过本机账本查看、检查和卸载。

### 从旧管理器迁移

旧管理器包名是 `capability-center-demo`，新稳定包名是 `capability-center`。首次迁移时，在 DSH 插件页停用并移除旧管理器一次，但保留它安装的报告格式、本机系统信息和 Tabulate，也不要先删除 DSH 配置。此后核心更新不需要卸载 `capability-center`。

- 旧版技能和 Python 库凭原安装回执迁入本机账本，可离线检查、诊断和由能力中心卸载。
- 旧版仅存在于 DSH profile 的插件只做识别、检查和试用，不由能力中心接管或卸载。请到“DSH 插件页”管理这类插件。
- 由本版能力中心新安装的插件进入账本，支持检查、修复和安全卸载。

## 使用

- “安装 / 更新 / 试用”是主操作；“更多”提供“检查与修复”“卸载”“详情”。
- 安装完成后自动执行目录声明的有界检查。离线时仍可读取本机账本、诊断和卸载已安装能力。
- “试用”只通过 DSH 可信客户端桥新建会话并填入草稿，不会自动发送。
- 顶部“检查更新 / 准备更新”只下载、校验并持久化下一版核心。当前任务继续运行，下一次启动 DSH 时激活；候选启动失败会回退上一健康核心。
- 隐藏组件不与组合一起显示，也不能被单独安装、检查、试用或卸载。目录仍以平面依赖图表示依赖关系。

## Office 增强

“Office 增强”是一个可见组合，内部固定引用隐藏技能 `office-enhancement-skill@1.0.0` 和隐藏包 `python-pypdf@7.1.0`。它复用 DSH Python 中的 `python-docx 1.2.0`、`openpyxl 3.1.5`、`python-pptx 1.0.2`、`pandas 3.0.1`，并要求 Python `>=3.11 <3.13`。兼容目标为 DSH `0.2.1-rc.2`。

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
node tools/publish.mjs core --storage dist --archive dist/core/capability-center-core-0.2.3.zip
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
