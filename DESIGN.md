# 技术设计

## 目标与兼容边界

目标宿主是 DSH `0.2.1-rc.2`，当前能力中心核心版本是 `0.2.2`。这里的 `0.2.2` 是能力中心发布版本，不是目标 DSH 宿主版本。稳定引导包名为 `capability-center`，可替换核心包名为 `capability-center-core`。产品不访问公共 npm、GitHub、pip 或模型；所有运行制品和依赖闭包由内网只读服务提供。

设计参考了 [dsh-market](https://github.com/dsh-market/dsh-market/tree/88de9575946485c1dac5e1a5fbe57fa1f3c3988c)。对该仓库 `88de9575946485c1dac5e1a5fbe57fa1f3c3988c`（`dshmarket@1.73.20`，MIT）仅借鉴目录/本机分离、变更前日志、明确更新状态和失败码等架构模式，没有复制其大段实现或品牌资产。其官方桌面原位更新在宿主提供 package manager 时可用，但依赖公共包通道；本产品改用稳定引导与版本化核心，以适配无明显通用热替换保证的隔离内网。

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

引导的 `ctx.effect` 注册路由并监督子插件。激活候选时调用 `ctx.plugin(module, { runtime })`，捕获返回 Fiber，并显式 `await fiber.await()`；失败后调用 `fiber.dispose()` 释放其已注册路由，再用相同流程启动上一健康核心或种子。引导 dispose 会停止接受新工作并 drain 启动/核心暂存队列。

`engine-state.json` 保存 `current`、`previous`、`pending` 和最近失败。核心 ZIP 在 `.staging-*` 解包并通过 manifest、`type: module`、入口、rc.2 兼容、字节数和 SHA-256 检查后，原子 rename 到不可变 `releases/<version>`。同版本不同哈希会被拒绝。待激活版本只在下一次 DSH 启动尝试；当前运行时保持原核心，失败后回退。

## 目录与能力模型

目录 schema v2 的每个条目包含稳定 ID、类型、名称、语义版本、兼容矩阵、描述、用法、试用提示和类型化检查。可选 `hidden: true` 只用于组合的内部组件：服务端校验布尔类型，Web UI 过滤隐藏行，安装、诊断、试用和卸载入口拒绝组件直接动作。制品路径必须与目录同源。组合条目不含制品，只包含固定 `{id, version}` 引用。

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

更新先下载并验证计划内全部制品，比较语义版本，绝不隐式降级。技能与 Python 发布到版本化内部目录，活动路径通过同文件系统 rename 切换；失败恢复旧文件。插件先保留旧 TGZ，再从目标插件外部调用宿主移除/安装，并据 `ChangeResult.application` 与 `listBundles` 报告 applied、restart-required 或 failed。

检查只接受声明类型：

- `skill-discovery`：本产品注册后从 DSH 技能注册表读回。
- `named-tool-readonly-call`：结果必须显式 `isError: false`，并含 content 或 value；缺失值不算成功。
- `python-import`：在 DSH 返回的真实 Python 中导入并校验版本。
- `python-function`：只允许实现内固定的 `tabulate-table` 检查，并验证真实表格内容。
- `office-smoke`：只允许固定的 `office-enhancement` 组合使用；从哈希固定的第一方技能资产运行已知检查脚本，使用真实 DSH Python 验证固定库版本并创建临时 PDF、DOCX、XLSX、PPTX 夹具执行实际操作。

## 可信草稿桥

网页只向同源 `window.parent` 发送 `requestId`、item ID、受限 prompt 和 origin。客户端闭包再次验证消息键、类型、ID、长度、origin 和 frame source；会话创建、retain 和 `requestDraftInitialization` 均在 DSH 客户端服务内完成。随后打开正常会话视图并回传 ack。流程不调用发送接口，源码测试断言不存在自动 `.submit()`。

## 发布与分发

`build.mjs` 离线使用 `npm pack`、本机 Python `zipfile` 和 Node 标准库生成 bootstrap TGZ、示例能力、Office 技能、版本化核心 ZIP、目录、核心索引、只读服务与离线 ZIP。新核心和 Office ZIP 使用排序路径、固定 ZIP 时间戳与固定权限位，重复构建得到稳定摘要。作者侧 `tools/publish.mjs` 再验证清单、平面依赖图、版本路径、字节数、哈希和核心协议。持久 `publication-registry.json` 在目录写入前保留每个 `id@version` 的 manifest/制品哈希与路径；历史不因下架删除，同版本任何内容变化都返回不可变冲突。最后原子更新目录/索引。

分发服务基于 Python 标准库，仅提供 GET/HEAD，按白名单目录流式发送不可变制品，拒绝路径穿越、目录、符号链接和写方法。`start-server.cmd` 会依次查找显式环境变量、`DSH_HOME`、用户目录、DeepSeek Harness 安装目录和 PATH 中的 Python。

## 验收边界

自动测试覆盖账本原子写、提交崩溃边界、普通异常回滚、模拟崩溃后恢复、插件回滚验证、共享固定依赖冲突、离线/下架卸载、无降级、核心下次启动激活与失败回退、Node 24 close-FIN、真实 Python 3.12 venv、可信草稿桥和分发服务。Office 测试使用真实 DSH Python 和实际 pip 安装的官方 pypdf，覆盖 fresh、borrowed、无制品端点复用、共享引用、冲突拒绝、异常回滚、注册表清理和卸载保留外部安装。Windows 与真实 DSH 桌面 UI 必须在目标机上另行验收；本轮环境只能完成 macOS 构建、单元与集成检查。
