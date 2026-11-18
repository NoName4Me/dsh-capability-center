# DSH 能力中心：市场方案旁路对比

核查日期：2026-11-17。比较面向 DSH `dsh-v0.2.1-rc.2`，结论基于下文固定提交的源码，运行情况仍需实机验证。

## 结论

**建议借鉴模式，不整包移植任一公网市场。** 2BingLing 的价值在技能/插件分流、安装前备份和更新前后核对；Hub 的价值在目录与本机清单分离、串行任务和失败诊断；canonical 的价值在精确更新状态与持久化恢复。它们均不能直接证明 rc.2 内网离线安装或自身升级已解决。正式中心应继续以本地制品、真实宿主结果和安装回执为基线，另行验证自身更新的执行生命周期。

## 身份与固定基线

| 仓库 | 本次代码基线 | 许可及定位 |
| --- | --- | --- |
| `2BingLing/dsh-market` | [`3a323cd0f3f8dd52482b785959c5efab3eb0495e`](https://github.com/2BingLing/dsh-market/tree/3a323cd0f3f8dd52482b785959c5efab3eb0495e)；[`@dsh-market/core` 0.4.18](https://github.com/2BingLing/dsh-market/blob/3a323cd0f3f8dd52482b785959c5efab3eb0495e/plugin/core/package.json)、[`@dsh-market/plugin` 0.4.22](https://github.com/2BingLing/dsh-market/blob/3a323cd0f3f8dd52482b785959c5efab3eb0495e/plugin/ui/package.json) | [源码/文档 MIT，但品牌 logo、图标、域名保留权利](https://github.com/2BingLing/dsh-market/blob/3a323cd0f3f8dd52482b785959c5efab3eb0495e/LICENSE#L25-L40)。技能与插件双通道。 |
| `dshplugin/dsh-plugin-hub` | [`154d33f9e9775f7fee08ac4314c644e8074912ff`](https://github.com/dshplugin/dsh-plugin-hub/tree/154d33f9e9775f7fee08ac4314c644e8074912ff)；[`dsh-plugin` 2.3.9](https://github.com/dshplugin/dsh-plugin-hub/blob/154d33f9e9775f7fee08ac4314c644e8074912ff/package.json) | [MIT](https://github.com/dshplugin/dsh-plugin-hub/blob/154d33f9e9775f7fee08ac4314c644e8074912ff/LICENSE)。以 npm 插件管理为核心。 |
| `dsh-market/dsh-market`（唯一补充比较项） | [`88de9575946485c1dac5e1a5fbe57fa1f3c3988c`](https://github.com/dsh-market/dsh-market/tree/88de9575946485c1dac5e1a5fbe57fa1f3c3988c)；[`dshmarket` 1.73.20](https://github.com/dsh-market/dsh-market/blob/88de9575946485c1dac5e1a5fbe57fa1f3c3988c/package.json) | [MIT](https://github.com/dsh-market/dsh-market/blob/88de9575946485c1dac5e1a5fbe57fa1f3c3988c/LICENSE)。由主线提供结论，本笔记只复核关键更新分支。 |

两个指定仓库的 full name、公开性、默认分支已由 GitHub 连接器核实，分别为 master/main；它们不是同一个仓库。公共 REST 请求本次返回 403，未取得包含 star 数的 API 元数据，故不报告旁路项目热度。README 的收录量、人工审核数量与目录评分均不作为质量或安全证据；主线提供的 canonical star 数也不参与采用决策。

## 代码核实与适配判断

| 主题 | 2BingLing：代码已核实 | Hub：代码已核实 | 对 rc.2 的判断 |
| --- | --- | --- | --- |
| 安装 / 更新 | 技能浅克隆 GitHub；覆盖前把旧目录改名备份，失败恢复。插件执行 `dsh plugin --profile … add`；更新显式 `@latest`，读安装前后实际版本，技能核对 HEAD。[安装器](https://github.com/2BingLing/dsh-market/blob/3a323cd0f3f8dd52482b785959c5efab3eb0495e/plugin/core/src/installer.ts#L174-L295)、[更新](https://github.com/2BingLing/dsh-market/blob/3a323cd0f3f8dd52482b785959c5efab3eb0495e/plugin/core/src/update.ts#L447-L522) | 排队执行 CLI；更新映射为 `add`，目标取锁定版本或 latest。桌面环境探测宿主 CLI bootstrap，而非直接调用 `installBundle`。[调用及引导](https://github.com/dshplugin/dsh-plugin-hub/blob/154d33f9e9775f7fee08ac4314c644e8074912ff/src/server/services/install/task-queue.ts#L158-L220)、[更新参数](https://github.com/dshplugin/dsh-plugin-hub/blob/154d33f9e9775f7fee08ac4314c644e8074912ff/src/server/services/install/task-queue.ts#L447-L456) | 借鉴操作队列、前后核对、失败备份；不照搬 CLI/bootstrap 路径或假设 add 能覆盖。 |
| 自更新 | `update:self` 的 apply 分支明确 `applied:false, needsManual:true`，只给停止宿主后的命令。[实际分支](https://github.com/2BingLing/dsh-market/blob/3a323cd0f3f8dd52482b785959c5efab3eb0495e/plugin/ui/src/index.ts#L264-L283) | 自身也走上述 CLI 变更链；待重启列表是进程内数组，重启即清空。[内存列表](https://github.com/dshplugin/dsh-plugin-hub/blob/154d33f9e9775f7fee08ac4314c644e8074912ff/src/server/services/profile/pending-restart.ts) | 两者都不是 rc.2 安全自更新的已验收实现。自身更新需外部执行者，或宿主支持的原位更新后重启。 |
| 已安装清单 | 扫技能目录，并扫 profile dependencies / bundles 去重；尽量读 node_modules 的实际版本。[扫描](https://github.com/2BingLing/dsh-market/blob/3a323cd0f3f8dd52482b785959c5efab3eb0495e/plugin/core/src/installed.ts#L16-L101)、[实际版本](https://github.com/2BingLing/dsh-market/blob/3a323cd0f3f8dd52482b785959c5efab3eb0495e/plugin/core/src/installed.ts#L258-L277) | profile 依赖表与目录合并；API 分别下发 paths、loaded、dshCapable、版本账本，未收录项也可显示。[清单接口](https://github.com/dshplugin/dsh-plugin-hub/blob/154d33f9e9775f7fee08ac4314c644e8074912ff/src/server/http/task.ts#L170-L190)、[视图模型](https://github.com/dshplugin/dsh-plugin-hub/blob/154d33f9e9775f7fee08ac4314c644e8074912ff/src/client/logic/installed.ts#L23-L57) | 采用“本机事实优先、目录补充说明”；manifest spec、实际文件版本、运行态分别表达，不能把已声明依赖等同已启用。 |
| Skills | 独立技能安装/扫描通道；更新提示用 pushedAt 对比目录 mtime，执行后才比 HEAD。[检测](https://github.com/2BingLing/dsh-market/blob/3a323cd0f3f8dd52482b785959c5efab3eb0495e/plugin/core/src/update.ts#L304-L345) | 已核查安装/清单主链是 npm/profile/loader 模型；本轮未发现独立 SKILL.md 导入与技能回执通道，不能由“插件”目录宣称支持推出技能管理。 | 采用类型分流；不采用 mtime/pushedAt 作可靠版本身份。离线技能应固定包版本、文件哈希，并单独验证 runtime 注册。 |
| 离线 / 无登录 | 可配置 remoteUrl/liteUrl/localPath，并有缓存优先与失败回退；但默认仍走 Pages/CDN，安装 GitHub/npm。另有 GitHub device OAuth 分支。[配置](https://github.com/2BingLing/dsh-market/blob/3a323cd0f3f8dd52482b785959c5efab3eb0495e/plugin/core/src/config.ts#L81-L98)、[取数](https://github.com/2BingLing/dsh-market/blob/3a323cd0f3f8dd52482b785959c5efab3eb0495e/plugin/core/src/data.ts#L82-L140)、[OAuth](https://github.com/2BingLing/dsh-market/blob/3a323cd0f3f8dd52482b785959c5efab3eb0495e/plugin/ui/src/index.ts#L839-L855) | 目录 URL 固定 api.dsh-plugin.org；磁盘缓存 1h，联网失败可回退任意年龄旧缓存。安装仍依赖 registry/CLI。[目录及回退](https://github.com/dshplugin/dsh-plugin-hub/blob/154d33f9e9775f7fee08ac4314c644e8074912ff/src/server/http/catalog.ts#L118-L181) | 无账号可访问公开目录不等于全离线。内网需本地目录优先、禁公网回源/自动换公共镜像、制品与传递依赖闭包；清除 OAuth、收藏同步等公网流程。 |

**README 与代码的边界：** Hub README 宣称可一键覆盖升级、市场自身可更新，这是产品说明；本次实际看到的是 CLI add、loader 尝试与待重启记录，未验证 rc.2 桌面执行成功。2BingLing 的自更新则由源码明确降级为手动指引。均未完成端到端运行验证；目录“verified”也不等于安装包已审计。[Hub README](https://github.com/dshplugin/dsh-plugin-hub/blob/154d33f9e9775f7fee08ac4314c644e8074912ff/README.md)

## canonical 的关键补充（主线结果，关键代码已复核）

- **更新状态值得采用。** `updates.ts` 区分 notAPlugin、checkFailed、未发布提交与 release、channelSwitch 与 upgrade；内网目录不可达应显示“检查失败/未知”，不能显示“已最新”。[状态字段](https://github.com/dsh-market/dsh-market/blob/88de9575946485c1dac5e1a5fbe57fa1f3c3988c/src/updates.ts#L28-L115)
- **自身更新有条件可行，并非一律不能。** `updateMarketInPlace()` 有宿主 packageManager invocation 和 profileDirectory 时执行宿主 pnpm `add spec`，保持自身不被卸载；核对落盘版本后返回 restart-required。上下文缺失才返回 market-self-update 拒绝。它证明一种设计路径，不证明目标 rc.2 提供同样上下文或离线依赖闭包。[原位更新及拒绝分支](https://github.com/dsh-market/dsh-market/blob/88de9575946485c1dac5e1a5fbe57fa1f3c3988c/src/official-desktop.ts#L278-L314)
- **重启恢复必须持久化。** 普通插件 remove→add 前先写 per-profile journal，安装完成才清除，重启可恢复中断更新；API 保留 market-self-update 与 update-incomplete 等可操作失败码。它与 Hub 的内存“待重启列表”用途不同，后者不能替代中断恢复。[更新日志](https://github.com/dsh-market/dsh-market/blob/88de9575946485c1dac5e1a5fbe57fa1f3c3988c/src/pending-updates.ts#L1-L44)、[失败码](https://github.com/dsh-market/dsh-market/blob/88de9575946485c1dac5e1a5fbe57fa1f3c3988c/src/update-api-v1.ts#L91-L116)

## 正式中心的采用 / 不采用

1. **采用：** 目录与本机清单分离、Skills/Bundle/Python 分类型适配；显示已落盘版本、已注册/运行态、验证结果和待重启状态。Hub 版本账本用临时文件 rename 原子写入，可借鉴写法，但记录应以实际安装制品为准。[账本实现](https://github.com/dshplugin/dsh-plugin-hub/blob/154d33f9e9775f7fee08ac4314c644e8074912ff/src/server/services/profile/installed-versions.ts#L119-L131)
2. **采用：** 串行变更与可恢复操作日志；更新核对目标版本/哈希，明确检查失败与版本未变化。技能备份模式需补上受管回执及用户修改保护，不直接照搬整目录删除卸载。[技能卸载现状](https://github.com/2BingLing/dsh-market/blob/3a323cd0f3f8dd52482b785959c5efab3eb0495e/plugin/core/src/installer.ts#L476-L495)
3. **不采用：** 公网 latest、GitHub clone、目录评分驱动的任意命令或 AI 安装配方，作为无登录离线中心的默认安装机制；也不直接复用品牌资产。MIT 代码复用保留版权和许可，目录中每个第三方包仍需单独核对许可。
4. **自身更新先独立验证：** 禁止中心在自己的请求中先 remove 自身再补装。选择宿主原位换包→退出重启，或执行生命周期独立的更新器；先固化目标制品、校验、恢复记录，启动后复核版本。**这是建议方案，不是已实现功能。**

目标 rc.2 的 bundle/HMR、本地 tgz 与传递依赖限制沿用现有 [rc.2 源码笔记](dsh-rc2-capability-center.md)。本笔记未修改 demo，未新建 `/capability-center`，未验收任何候选方案在 rc.2/Windows/断网下可用。
