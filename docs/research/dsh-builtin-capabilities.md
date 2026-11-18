# 内网 DSH 内置能力清单

本清单适用于 [内网终端环境](../../DESIGN.md#内网终端环境)，按桌面版标准模式列出开发新能力时可复用的技能、工具和运行时。依据发布记录、默认配置与打包源码核查，实际可用性取决于会话预设、权限、模型和本机依赖。本次未在内网 Windows 终端运行验证。

| 环境 | 核查版本 |
| --- | --- |
| Windows 10 x64 | 官方 `deepseek-harness-0.2.2-rc.2`，提交 `ddac967`。 [官方发布](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2) |
| Windows 7 x64 | `deepseek-harness-0.2.1-rc.5-win7` 按社区发布 `dsh-v0.2.1-rc.5-win7.1` 核查，打包仓库固定 Harness 子模块到 `b1d80d6`。核查的安装包为 `deepseek-harness-0.2.1-rc.5-win7-x64-unsigned.exe`，SHA-256 为 `36fe3ad5452514faf1ec15188a025c336613acae30e58378e891ec97360acdc6`。 [社区发布](https://github.com/factfinding/dsh-win7/releases/tag/dsh-v0.2.1-rc.5-win7.1) · [打包提交](https://github.com/factfinding/dsh-win7/tree/b15ceb71bb22eb532b513b0cbb2e0b5b9f07a393) |

## Office 与 PDF

| 功能 | Windows 10 · 0.2.2-rc.2 | Windows 7 · 0.2.1-rc.5-win7.1 |
| --- | --- | --- |
| 办公路由 | `office` | `office` |
| Word | `office-docx`，读取、新建、编辑、验证 DOCX | 同左 |
| Excel | `office-xlsx`，读写 XLSX、处理数据、编辑样式与公式 | 同左 |
| PowerPoint | `office-pptx`，读取、新建、编辑、验证 PPTX | 同左 |
| 渲染 | `office_render`，渲染 Office 页面、幻灯片、工作表区域或 PDF 页，返回图片给模型 | `office-render` 技能指导调用随包 LibreOffice Kit CLI，支持 Office 和 PDF |
| 格式转换 | `office_convert`，Office 转 PDF，也支持 DOCX/ODT/TXT、XLSX/ODS/CSV、PPTX/ODP 等对应文档类型的输出 | `office-export-pdf` 技能指导调用 CLI 导出 PDF |
| 公式重算 | `office_recalculate`，接受 XLS/XLSX/ODS，输出 XLSX 或 ODS | `office-recalculate` 技能指导调用 CLI 刷新公式结果 |

Win10 有四项 Office 技能。在标准模式或 PTC 模式加载其中任一项后，从下一步起启用三个 Office 工具。渲染要求模型支持图片输入。转换与重算产出临时文件，需要复制到目标位置。Win7 有七项 Office 技能，其中渲染、导出和重算走技能说明中的 CLI 路径。 [Win10 技能](https://github.com/deepseek-ai/deepseek-harness/tree/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/skill/skill-office/assets) · [Win10 工具](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/document/tool-office/README.zh.md) · [Win7 技能](https://github.com/factfinding/deepseek-harness/tree/b1d80d6af0ad828937325aa917b06b9b3c6985e2/packages/skill/skill-office/assets) · [Win7 Host 装配](https://github.com/factfinding/deepseek-harness/blob/b1d80d6af0ad828937325aa917b06b9b3c6985e2/apps/desktop-host/src/office.ts)

两版的 PDF 基线包括预览或页面渲染，以及把 Office 文档导出为 PDF。PDF 合并、拆分、旋转、文字层提取继续复用能力中心的 Office 增强。扫描件文字识别需另备 OCR 引擎。 [Office 增强技能](../../src/capabilities/office-enhancement/SKILL.md) · [离线 OCR 调研](dsh-offline-ocr.md)

## 通用能力

| 能力 | 两版标准模式的共同入口 |
| --- | --- |
| 命令和后台任务 | Windows 的模型工具名为 `pwsh`。后台作业通过 `job_list`、`job_output`、`job_kill` 管理。 |
| 本地文件与搜索 | `read`、`write`、`edit`、`read_image`、`glob`、`grep`。读取图片受模型输入模态限制。 |
| 技能与交付 | `skill` 按需加载技能。内置 `dsh-doc` 用于查询 DSH 文档和开发插件。用 `present` 向用户展示产物。 |
| 计划、待办和提醒 | 计划模式、`todo_write`、目标工具 `create_goal` / `get_goal` / `update_goal`，以及 `schedule_create` / `schedule_list`。其余提醒工具见下方版本差异。 |
| 委派与工作流 | `subagent`、`subagent_fork`、`list_agents`、`wait_agent`、`send_message`、`workflow`。 |
| 用户输入与上下文 | `ask_user_question`、会话自动压缩与 `/compact`。 |
| 网页检索 | `web_search`、`web_fetch`。能否使用取决于提供方、内网连通性和凭据。 |

[Win10 标准预设](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/bundle/web-app/presets/standard.patch.yml) · [Win7 标准预设](https://github.com/factfinding/deepseek-harness/blob/b1d80d6af0ad828937325aa917b06b9b3c6985e2/packages/bundle/web-app/presets/standard.patch.yml)

- **桌面功能**。两版桌面都有插件管理，以及侧栏文件树、文档预览、浏览器标签页和终端。Win10 有 MCP 管理器，Win7 可通过 profile patch 配置 MCP 客户端。MCP 工具由配置的服务提供。Win10 标准模式还可在宿主提供可编辑 profile 时使用 `plugin_manager`。Win7 标准预设默认禁用该模型工具，桌面插件页仍可使用。 [Win10 桌面组合](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/bundle/web-app/cordis.patch.yml) · [Win7 桌面组合](https://github.com/factfinding/deepseek-harness/blob/b1d80d6af0ad828937325aa917b06b9b3c6985e2/packages/bundle/web-app/cordis.patch.yml) · [Win7 MCP 配置](https://github.com/factfinding/deepseek-harness/blob/b1d80d6af0ad828937325aa917b06b9b3c6985e2/docs/user/guide/mcp-memory.zh.md)
- **PowerShell**。Win7 适配包自带 PowerShell 7.2.24。Win10 官方版按配置和本机路径查找 PowerShell，找不到 PowerShell 7 时可回退到 Windows PowerShell。 [Win7 发布说明](https://github.com/factfinding/dsh-win7/releases/tag/dsh-v0.2.1-rc.5-win7.1) · [Win10 可执行文件查找](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/shell/pwsh-local/src/resolve.ts)
- **提醒工具差异**。Win10 用 `schedule_edit` 和 `schedule_view`，Win7 用 `schedule_update` 和 `schedule_delete`。 [Win10 工具源码](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/schedule/tool-schedule/src/index.ts) · [Win7 工具源码](https://github.com/factfinding/deepseek-harness/blob/b1d80d6af0ad828937325aa917b06b9b3c6985e2/packages/schedule/tool-schedule/src/index.ts)
- **网页检索默认配置**。Win10 默认搜索提供方为 `deepseek-search-api`，Win7 为 `deepseek-official`。网页抓取默认均为 `http`。 [Win10 共享配置](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/bundle/base/cordis.patch.yml) · [Win7 共享配置](https://github.com/factfinding/deepseek-harness/blob/b1d80d6af0ad828937325aa917b06b9b3c6985e2/packages/bundle/base/cordis.patch.yml)
- **Win10 的协作和评审**。支持具名、多层 SubAgent。AgentTeam 可按会话开启，提供成员树和共享任务。标准预设默认关闭 `interrupt_agent`，Win7 标准预设仍注册该工具。Git Worktree 支持按分支、提交、文件类型审阅改动，GitHub 评审功能需要相应接入。 [Win10 发布说明](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.2.2-rc.2) · [Win7 中断工具](https://github.com/factfinding/deepseek-harness/blob/b1d80d6af0ad828937325aa917b06b9b3c6985e2/packages/subagent/tool-subagent-control/src/index.ts) · [AgentTeam 入口](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/bundle/web-app/README.zh.md)
- **语音输入**。两版的本地 SenseVoice 语音输入均为默认关闭的可选插件。启用后还需准备语音模型，内网使用时需单独确认模型已就绪。 [Win10 语音插件](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/experimental/voice-input-bundle/README.zh.md) · [Win7 语音插件](https://github.com/factfinding/deepseek-harness/blob/b1d80d6af0ad828937325aa917b06b9b3c6985e2/packages/experimental/voice-input-bundle/README.zh.md)

## 随包工作区运行时

两版源码均锁定 Python `3.12.14` x64 和 Node.js `24.21.0`。Win7 的 Python 来源为 PythonVista NuGet，按社区构建的 Windows 依赖要求验证启动。需要运行脚本时，调用 `load_workspace_dependencies` 获取实际的 `python`、`pythonPackages`、`pythonDistributions`和 `node`，路径以该次返回为准。随包提供 pnpm 时还会返回 `pnpm` 路径。`pythonDistributions` 来自随包清单，用户后装的库应在实际解释器中另行检查。 [Win10 运行时锁](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/scripts/primary-runtime/lock.json) · [Win7 运行时锁](https://github.com/factfinding/deepseek-harness/blob/b1d80d6af0ad828937325aa917b06b9b3c6985e2/scripts/primary-runtime/lock.json) · [Win7 系统依赖](https://github.com/factfinding/dsh-win7/blob/b15ceb71bb22eb532b513b0cbb2e0b5b9f07a393/README.md#L26-L35) · [依赖查询接口](https://github.com/deepseek-ai/deepseek-harness/blob/ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c/packages/skill/tool-workspace-dependencies/src/index.ts)

| 用途 | 两版 Windows x64 随包 Python 发行包 |
| --- | --- |
| Word | `python-docx 1.2.0` |
| Excel | `openpyxl 3.1.5`、`XlsxWriter 3.2.9` |
| PowerPoint | `python-pptx 1.0.2` |
| 数据分析与数值计算 | `pandas 3.0.1`、`numpy 2.3.5` |
| 图片与 XML | `Pillow 12.3.0`、`lxml 6.1.3` |
| 其余运行依赖 | `python-dateutil 2.9.0.post0`、`six 1.17.0`、`tzdata 2025.2`、`typing_extensions 4.16.0`、`et_xmlfile 2.0.0` |

新增能力若依赖 `pypdf`、OCR 或其他清单外组件，应声明自己的离线依赖。两版都要支持的办公能力，可直接复用共同的 Python 库。涉及渲染、格式转换和公式重算时，按上表选择对应版本的入口，并记录实机结果。
