# 技术设计

## 目标与兼容边界

当前能力中心核心版本是 `0.2.12`。这里的 `0.2.12` 是能力中心发布版本，不是 DSH 宿主版本。核心协议继续以 DSH `0.2.1-rc.2` 作为内部兼容标记，稳定引导的 `engines.dsh` 则声明为 `>=0.2.1-rc.2 <0.2.3`，覆盖文档中的 Win7、Win10 和已实测 macOS Web 基线。稳定引导包名为 `capability-center`，可替换核心包名为 `capability-center-core`。产品不访问公共 npm、GitHub、pip 或模型；所有运行制品和依赖闭包由内网只读服务提供。

设计参考了 [dsh-market](https://github.com/dsh-market/dsh-market/tree/88de9575946485c1dac5e1a5fbe57fa1f3c3988c)。对该仓库 `88de9575946485c1dac5e1a5fbe57fa1f3c3988c`（`dshmarket@1.73.20`，MIT）仅借鉴目录/本机分离、变更前日志、明确更新状态和失败码，以及 `shell.overlay` 全局提示/`sessionStorage` 一次性消费等架构模式，没有复制其大段实现或品牌资产。其官方桌面原位更新在宿主提供 package manager 时可用，但依赖公共包通道；本产品改用稳定引导与版本化核心，以适配隔离内网。

### 内网终端环境

| 操作系统 | 架构 | 已安装的 DSH |
| --- | --- | --- |
| Windows 10 | x64 | `deepseek-harness-0.2.1-rc.2` |
| Windows 7 | x64 | `deepseek-harness-0.2.1-rc.5-win7` |

新增或修改能力时，以这两组环境为参考，分别评估宿主接口、运行时依赖和离线安装的兼容性。实机验证结果按对应的 Windows 和 DSH 版本记录。

开发新能力前，先查阅 [DSH 内置能力清单](docs/research/dsh-builtin-capabilities.md)，了解两版可复用的技能、工具和随包运行时。

## 进程与生命周期

```text
DSH native plugin: capability-center
  ├─ sidebar + /capability-center same-origin routes
  ├─ EngineSupervisor
  ├─ engine-seed (shipped in bootstrap tgz)
  └─ DSH_HOME/capability-center/
       ├─ engine-state.json
       ├─ releases/<version>/
       ├─ data/ledger.json
       ├─ operations/<operation>.json
       ├─ artifacts/<id>/<version>/
       ├─ rollback/<operation>/
       └─ removed/
```

引导的 `ctx.effect` 注册路由并监督子插件。hot 激活、核心 stage 和既有启动路径共用同一生命周期队列。执行“刷新生效”时，supervisor 先写 `bootAttempt`，再调用旧引擎 `stopAcceptingWork()`、等待操作队列和正在转发的请求 drain，并 dispose 旧 Fiber。随后调用 `ctx.plugin(module, { runtime })`，显式 `await fiber.await()`，并要求候选服务的 `verify()` 返回同版本 `ready`。Fiber 的 `dispose()` 可能同步返回 `void`，因此清理统一包在 `try/await` 中且每个失败候选只清理一次。

候选验证或状态提交失败时，supervisor 重启已保存的旧核心并再次验证。若恢复成功，则清理 `bootAttempt`、删除并隔离失败候选、清空 pending，只向 UI 返回失败和“已回退”；若旧核心也无法恢复，则保留故障事实并明确返回未恢复，不声称 healthy core 仍在运行。进程在 hot 启动中途退出时，下一次启动先读取并清理持久 `bootAttempt`，隔离未完成候选，再启动已知 current。

`engine-state.json` 保存 `current`、`previous`、`pending` 和最近失败。核心 ZIP 在 `.staging-*` 解包并通过 manifest、`type: module`、入口、内部 rc.2 兼容标记、字节数和 SHA-256 检查后，原子 rename 到不可变 `releases/<version>`。同版本不同哈希会被拒绝。新版 bootstrap 若发现自带 seed 严格高于 persisted current，且没有更高的 pending、同版 seed 没有被此前隔离，就把 seed 作为启动候选用 `bootAttempt` 路径提级；dev seed 也通过同一 `activationRoot` 读取，不假设 `releases/` 已存在。

旧 bootstrap 没有 hot activation 路由时，会继续读取持久 `pending` 并在下一次自然启动中激活。新版核心不会向这类宿主展示不可工作的按钮，而是通过 `/api/status` 中的 `refreshBridge` 能力字段退化为“下次启动 DSH 生效”。这同时保留历史宿主兼容和旧候选自然生效路径。

## 目录与能力模型

目录 schema v2 的每个条目包含稳定 ID、类型、名称、语义版本、兼容矩阵、描述、用法、试用提示和类型化检查。可选 `hidden: true` 只用于组合的内部组件：服务端校验布尔类型，Web UI 过滤隐藏行，安装、诊断、试用和卸载入口拒绝组件直接动作。制品路径必须与目录同源。组合条目不含制品，只包含固定 `{id, version}` 引用。

可见顶层分类为技能、插件、MCP 和能力包。MCP 不是 Python 的别名，而是插件条目上可选的 `category: "mcp"` 标注，只有未来条目确实随 DSH 插件注册 MCP 时才使用；manifest 校验拒绝非插件类型携带该字段。当前 Draw.io 画布由 DSH 原生 `drawio_*` 工具注册，MCP 上游 tarball 只提供静态编辑器资产，所以不能归入 MCP。Python wheel 继续作为 Office 等组合的隐藏依赖，由本机账本检查和卸载，但不再占顶部筛选。

可见插件条目使用现有本地 TGZ、`installBundle`、账本和回滚路径。安装时显式请求启用；`plugin-bundle` 检查从目录条目派生包名和版本，再读取宿主 `listBundles()` 与 `listPlugins()`，分别报告已激活、停用、缺失、启动失败和待重启。只有对应 Loader 行的 `fiberPhase` 为 `active` 时才清除 `restart-required` 状态。

首版执行平面组合限制：组合的直接子项必须是非组合，且子项不能再声明传递依赖。依赖图仍统一验证重复 ID、缺失项、固定版本不一致和环；超出平面范围时返回 `unsupported-nested-composite`，避免声称支持任意依赖求解。

`dependencyOwners` 记录哪些组合引用一个已安装子能力。卸载组合时只移除自己的所有权；仍有其他所有者或直接安装标记时保留文件。更新共享子能力前，如果计划外的已安装能力仍固定旧版本，则拒绝更新并要求在同一计划中协调升级。

## 账本、日志与恢复

`data/ledger.json` 是原子写入的本机事实，保存版本、来源、制品哈希、受管文件、运行根、依赖所有权、最近健康和最近操作。目录离线时，账本中的序列化 manifest 足以显示、检查本地制品和卸载；下架条目不要求网络。

每次磁盘或 profile 变更前先原子写入 `operations/<id>.json`。变更意图是有序 append-only 记录：

- 技能与 Python：在移动活动目录或 `.pth` 前记录旧路径、备份和是否存在旧版本。
- 插件：在 `removeBundle` 前记录旧版 TGZ 与版本，在 `installBundle` 前记录目标包；宿主结果必须为 `applied`、`restart-required` 或 `overridden`，恢复时再次用 `listBundles` 验证。
- 组合：每个子项分别 append 意图，不覆盖前序意图。

普通异常会按 operation ID 重新读取磁盘上的最新 journal，逆序恢复所有意图；不能只使用 `begin()` 时内存对象。恢复若有任何文件或宿主结果无法证明，会保留 journal 与备份、设置 `recoveryRequired` 并阻止新变更。

提交顺序是先原子写新账本，再把 journal 标记为 `committed`，最后删除 journal。若进程在账本写完后、标记前退出，恢复会逆序意图并恢复 `beforeLedger`；若已标记 committed，恢复只需清理日志，因为账本已先落盘。

## 更新与检查

更新先下载并验证计划内全部制品，比较语义版本，绝不隐式降级。技能与 Python 发布到版本化内部目录，活动路径通过同文件系统 rename 切换；失败恢复旧文件。插件先保留旧 TGZ，再从目标插件外部调用宿主移除/安装，并据 `ChangeResult.application` 与 `listBundles`/`listPlugins` 报告 applied、restart-required 或 failed。

普通插件只有在宿主结果和运行态共同证明 `applied`/`active` 时提示“刷新页面生效”，不把它升级成重启要求。`restart-required`、模块或宿主变更确实不能热加载时，保留独立且真实的“重启 DSH”提示。刷新动作先由页面在 `sessionStorage` 写入 `{target,itemId,version,action}`，再通过严格校验 `origin`、frame source、字段集合和目标 ID 的同源桥请求顶层 reload。`action` 区分 install/update/activate，install 与 update 的成功文案分别使用“已安装并生效”和“已更新并生效”。

DSH 顶层刷新不会保留能力中心 panel。当前客户端在 `shell.overlay` 注册全局 toast，并在刷新后读取 `sessionStorage` 标记；只有 auth 的 `/api/refresh-state` 返回目标插件真实 `plugin-bundle` 检查为 `ready` 且版本一致，或核心 activeVersion/ready 一致时才消费并显示一次成功。宿主消费先取得短时 claim，旧宿主或槽不可用时 iframe 延迟 claim 后执行同样校验作为降级。`layout` 始终不是必需 inject，不使用未验证的 `layout.selectPanel` 或 DOM 模拟侧栏点击。

侧栏图标用 currentColor SVG 并直接在图标组件内绘制右上红点。客户端首次运行、每 15 分钟、重新联网、页面恢复可见、server/offline 设置变化和操作完成时检查 `/api/updates`；请求使用 AbortController，新的检查、pagehide、插件卸载和刷新会取消旧的 timer/请求。`/api/updates` 只对已安装且可见的条目、且目录版本语义上严格更高时报告更新；hidden、legacy hidden、相同/较低版本、目录读取失败和离线远端探测都不产生假阳性。核心红点只来自真实更新或 pending。离线设置下不访问远端，但仍可依据本机 pending 提示。

检查只接受声明类型：

- `skill-discovery`：本产品注册后从 DSH 技能注册表读回。
- `named-tool-readonly-call`：结果必须显式 `isError: false`，并含 content 或 value；缺失值不算成功。
- `python-import`：在 DSH 返回的真实 Python 中导入并校验版本。
- `python-function`：只允许实现内固定的 `tabulate-table` 检查，并验证真实表格内容。
- `office-smoke`：只允许固定的 `office-enhancement` 组合使用；从哈希固定的第一方技能资产运行已知检查脚本，使用真实 DSH Python 验证固定库版本并创建临时 PDF、DOCX、XLSX、PPTX 夹具执行实际操作。
- `plugin-bundle`：只允许插件使用；从固定目录条目派生包名与版本，读取真实 BundleInfo 及 Loader 运行态，不依赖虚构工具。

## 可信草稿桥

网页只向同源 `window.parent` 发送 `requestId`、item ID、受限 prompt 和 origin。客户端闭包再次验证消息键、类型、ID、长度、origin 和 frame source；会话创建、retain 和 `requestDraftInitialization` 均在 DSH 客户端服务内完成。随后打开正常会话视图并回传 ack。流程不调用发送接口，源码测试断言不存在自动 `.submit()`。

## 页面与反馈

页面使用两行网格：`html/body` 与 iframe 父高均为 100%，主内容区独立滚动，底部反馈入口占用专用自动行，不覆盖滚动卡片。iframe 不再声明 `minHeight: 560px`，矮视窗由 main 自己滚动。反馈使用带标题和说明关联的原生 dialog，弹窗内只说明可反馈内容并保留“点击反馈”；没有 textarea、必填 Win/DSH 字段、伪附件选择或第二个取消按钮。

`CAPABILITY_CENTER_FEEDBACK_EMAIL` 可通过 DSH 进程环境和构建注入。构建优先读取环境变量，其次读取 git 忽略的 `.env`，只把合法地址写入不可跟踪的 bootstrap 生成配置；构建和预览日志不输出地址。`/api/config` 只返回通过格式和长度校验的地址。点击反馈创建同 frame 的普通 `<a href="mailto:...">` 并触发一次，不使用 `window.open`、`_blank` 或 `_top`，正文以 CRLF 预填问题/需求、能力及版本、Win7/Win10、DSH 版本、步骤、实际/期望、截图和核心版本；附件由用户在邮件客户端添加。Win7 `0.2.1-rc.5-win7` 只把 http/https 交给 shell，mailto 路径和设备行为仍需实机验收。

侧栏与 favicon 使用同一轨道/罗盘 SVG，跟随宿主 currentColor tint，并为 16px sidebar、小 favicon 和暗色主题保持清晰轮廓。

## 发布与分发

`build.mjs` 离线使用 `npm pack`、本机 Python `zipfile` 和 Node 标准库生成 bootstrap TGZ、示例能力、Office 技能、版本化核心 ZIP、目录、核心索引、只读服务与离线 ZIP。新核心和 Office ZIP 使用排序路径、固定 ZIP 时间戳与固定权限位，重复构建得到稳定摘要。新 bootstrap、核心和 Office 内容变化都提升版本，不覆盖相同版本制品。作者侧 `tools/publish.mjs` 再验证清单、平面依赖图、版本路径、字节数、哈希和核心协议。持久 `publication-registry.json` 在目录写入前保留每个 `id@version` 的 manifest/制品哈希与路径；历史不因下架删除，同版本任何内容变化都返回不可变冲突。最后原子更新目录/索引。反馈邮箱若作为构建配置注入，只进入 git 忽略的离线生成物；部署侧也可在 DSH 进程设置运行时环境变量覆盖。

分发服务基于 Python 标准库，仅提供 GET/HEAD，按白名单目录流式发送不可变制品，拒绝路径穿越、目录、符号链接和写方法。`start-server.cmd` 会依次查找显式环境变量、`DSH_HOME`、用户目录、DeepSeek Harness 安装目录和 PATH 中的 Python。

## 验收边界

自动测试覆盖账本原子写、提交崩溃边界、普通异常回滚、模拟崩溃后恢复、插件回滚验证、可见插件目录与固定哈希、真实 BundleInfo 形状的安装/待重启/激活/卸载检查、共享固定依赖冲突、离线/下架卸载、无降级、旧 bootstrap 自然启动、hot 核心成功切换、同步 void dispose、候选失败回退/隔离、dev seed 提级、Node 24 close-FIN、真实 Python 3.12 venv、可信草稿桥、更新红点真实状态和分发服务。Office 测试使用真实 DSH Python 和实际 pip 安装的官方 pypdf，覆盖 fresh、borrowed、无制品端点复用、共享引用、冲突拒绝、异常回滚、注册表清理和卸载保留外部安装。

macOS DSH Web `0.2.2-rc.3` 已实测：自动续跑 `1.1.0` 安装/宿主刷新/全局 toast、`1.1.1` 夹具更新/红点消失、核心 `0.2.7 → 0.2.8` hot activation/刷新/全局 toast、`0.2.9` 故障夹具保留 `0.2.8`，以及 feedback mailto 正文与底部布局。Windows 7 `0.2.1-rc.5-win7` 和 Windows 10 `0.2.1-rc.2` 仍需在目标机验证宿主 slot、真实 plugin manager 和 mailto 打开行为。
