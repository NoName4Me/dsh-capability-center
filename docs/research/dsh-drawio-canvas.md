# draw.io 画布与聊天选区调研

2026-11-19 确认交互范围。用户从对话创建图稿，进入画布模式后左侧持续显示 draw.io，右侧显示原会话。用户直接框选图形、连线或组，再在右侧输入指令，模型基于选区更新原图。

## 结论

**推荐以 Next AI Draw.io 的现成 DSH 集成为起点。** 它已经实现自然语言建图、手动编辑和图元选区读取，默认画布在 DSH 右侧栏。能力中心需要补齐消息内画板入口、左画布右聊天的工作区、会话与画板的绑定、选区传递和离线交付。实施细节见下文。 [Next AI Draw.io 的 DSH 集成](https://next-ai-drawio.jiang.jp/en/docs/mcp-clients#deepseek-harness) · [绘图工具](https://github.com/DayuanJiang/next-ai-draw-io/tree/9534a668e3bd53f9c08aa5b8d2d77f409ccd09d4/packages/mcp-server#readme)

- **完整可编辑画布和按需读取选区都有官方接口。** draw.io 的 Embed Mode 提供可编辑 iframe。宿主在用户点击时发起 `export` 请求，用 `format: "json"` 与 `selection: true` 取得当前页选区的结构数据。把这些数据附到聊天是聊天宿主的职责。[Embed Mode](https://www.drawio.com/docs/reference/embed-mode/#json-protocol) · [选区导出](https://www.drawio.com/docs/reference/embed-mode/#export)
- **官方 draw.io MCP App 提供聊天内交互预览和打开编辑器的入口。** 官方 App 已用聊天宿主的接口回传布局检查和渲染上下文。公开工具清单没有读取编辑器当前选区的工具，所核查的回传逻辑也没有从独立编辑器接收用户选区或编辑结果的通道。[MCP App 工作方式](https://github.com/jgraph/drawio-mcp/blob/9bd19b362038593bc8611d426c92cd62dc222302/mcp-app-server/README.md#L1-L42) · [上下文回传源码](https://github.com/jgraph/drawio-mcp/blob/9bd19b362038593bc8611d426c92cd62dc222302/mcp-app-server/src/shared.js#L3328-L3375)
- **实时选区提示与点击时读取选区的证据不同。** 公共嵌入协议记录了选区导出和清除动作。现有文档未列出选区变化通知。自托管编辑器可在 editor 内部用插件监听图模型的选区变化，再通过自定义消息把状态传给宿主，这依赖固定版本的内部接口。[公开动作与事件](https://www.drawio.com/docs/reference/embed-mode/#json-protocol) · [内置选区监听源码](https://github.com/jgraph/drawio/blob/f411a11f4f6b8994d869bdbc45f4d4d9e2284f34/src/main/webapp/js/grapheditor/EditorUi.js#L41-L50) · [自托管嵌入](https://github.com/jgraph/drawio/wiki/Embedding/1a6907f0ad07d660d49d06ea7e17ce45792b8d12#your-own-instance)

## 官方嵌入式编辑器

公网托管地址用 `https://embed.diagrams.net/?embed=1&proto=json`。官方 Wiki 也明确支持在自托管实例上使用同样的参数，由 iframe 宿主通过 `postMessage` 交换 JSON 字符串。嵌入模式下，图稿由宿主存储。另有只读 viewer 和 lightbox，可用于展示已有图稿。[Embed Mode](https://www.drawio.com/docs/reference/embed-mode/) · [编辑器、viewer 与自托管](https://github.com/jgraph/drawio/wiki/Embedding/1a6907f0ad07d660d49d06ea7e17ce45792b8d12) · [官方集成示例](https://github.com/jgraph/drawio-integration)

| 行为 | 官方接口与边界 |
| --- | --- |
| 初始化和加载 | JSON 模式等 `{event: "init"}`，再发 `{action: "load", xml: "…"}`，编辑器返回 `load`。使用 `configure=1` 时先完成 `configure` 握手。加载可接收 XML 或压缩 XML，也有 CSV、Mermaid 描述符。[配置与加载](https://www.drawio.com/docs/reference/embed-mode/#configuration) · [JSON 协议](https://www.drawio.com/docs/reference/embed-mode/#json-protocol) |
| 保存和退出 | `save` 返回当前图稿 XML，保存并退出时另带 `exit: true`。单独退出发 `exit` 和 `modified`。加载时传 `autosave: 1` 可接收编辑变化，`diffSync` 是可选的补丁与校验协议。[保存和退出](https://www.drawio.com/docs/reference/embed-mode/#save-and-exit-events) · [增量同步](https://www.drawio.com/docs/reference/embed-mode/#diff-sync) |
| 读取文档与控制画布 | `export` 的 `xml` 格式用于取当前图稿 XML，另有 JSON、SVG、PNG 等格式。协议还包含 `fit`、`viewbox`、`invokeAction` 与 `resetEditor`，其中 `resetEditor` 会清空选区。[导出和画布动作](https://www.drawio.com/docs/reference/embed-mode/#export) · [清除状态](https://www.drawio.com/docs/reference/embed-mode/#reseteditor) |
| iframe 边界 | 官方示例核对消息的 `event.source` 与 `event.origin`，发送时指定编辑器的目标 origin。自托管还要允许聊天页面嵌入。标签、元数据和导出内容由图稿提供，宿主应把它们当作输入数据处理。[官方安全说明](https://github.com/jgraph/drawio/wiki/Embedding/1a6907f0ad07d660d49d06ea7e17ce45792b8d12#security-notes) |

## 选区能返回什么

**按需读取。** 宿主发下列请求。编辑器回 `event: "export"`、`format: "json"`，请求会作为 `message` 回显，`data` 是对象，内含 `version` 和 `pages[].cells`。JSON 分支没有外层 `xml` 字段。[导出协议](https://www.drawio.com/docs/reference/embed-mode/#export) · [消息处理源码](https://github.com/jgraph/drawio/blob/f411a11f4f6b8994d869bdbc45f4d4d9e2284f34/src/main/webapp/js/diagramly/EditorUi.js#L33033-L33072)

```json
{"action":"export","format":"json","selection":true,"allPages":false,"includeData":false}
```

- **范围。** `selection: true` 始终取当前页的选中单元及其后代，即使 `allPages` 省略或设为 `true`。同时选中祖先与后代时，后代只输出一次。空选区在所核查版本返回一个当前页对象，其中 `cells: []`。选中一条边或一个组内节点时，`source`、`target` 或 `parent` 可以指向结果之外的 ID，因此不能从选区 JSON 假定所有引用均可解析。[选区遍历源码](https://github.com/jgraph/drawio/blob/f411a11f4f6b8994d869bdbc45f4d4d9e2284f34/src/main/webapp/js/diagramly/EditorUi.js#L42241-L42365) · [边与父级序列化](https://github.com/jgraph/drawio/blob/f411a11f4f6b8994d869bdbc45f4d4d9e2284f34/src/main/webapp/js/diagramly/EditorUi.js#L42172-L42200)
- **内容。** 单元结构含 `id`、`type`、可用的父级和连线端点 ID，以及按需出现的 `label`、原始 `html`、自定义 `metadata`。结构数据省略样式和几何，适合解释选区内容及关系。需要坐标、样式或无损重开时，XML 才包含完整模型信息。固定版本的 `includeData: true` 会在 `data.data` 附加 XML，`selection: true` 时走选区 XML 序列化。单独请求 `format: "xml"` 则走图稿 XML 分支，源码未读取 `selection` 参数。[JSON 数据结构](https://www.drawio.com/docs/reference/embed-mode/#export) · [格式分支](https://github.com/jgraph/drawio/blob/f411a11f4f6b8994d869bdbc45f4d4d9e2284f34/src/main/webapp/js/diagramly/EditorUi.js#L33056-L33072) · [选区 XML 调用](https://github.com/jgraph/drawio/blob/f411a11f4f6b8994d869bdbc45f4d4d9e2284f34/src/main/webapp/js/diagramly/EditorUi.js#L42334-L42349) · [图模型 XML 编码](https://github.com/jgraph/drawio/blob/f411a11f4f6b8994d869bdbc45f4d4d9e2284f34/src/main/webapp/js/grapheditor/Editor.js#L1974-L1993)
- **实时选区或精确 ID。** 公开导出带上后代，响应里没有标记哪些单元由用户直接选中。插件内部可借助 `Draw.loadPlugin` 取得 `ui.editor.graph`，监听 `graph.getSelectionModel().addListener(mxEvent.CHANGE, …)` 并读取 `graph.getSelectionCells()`。宿主要收到变更，仍需自定义 iframe 消息。文档里的插件事件 `embedLoaded` 通知图稿加载或同步完成。默认 `remoteInvoke` 也受函数白名单约束，未暴露 `getSelectionCells`。`embedInline=1` 会设置 `plugins=0`，`offline=1` 也会关闭常规插件加载。官方列出自托管的 `PostConfig.js` 和允许同源自定义插件等装载方式。[插件事件](https://www.drawio.com/docs/reference/embed-mode/#plugin-events) · [编辑器监听](https://github.com/jgraph/drawio/blob/f411a11f4f6b8994d869bdbc45f4d4d9e2284f34/src/main/webapp/js/grapheditor/EditorUi.js#L41-L50) · [插件示例](https://github.com/jgraph/drawio/blob/f411a11f4f6b8994d869bdbc45f4d4d9e2284f34/src/main/webapp/plugins/text.js#L5-L19) · [调用白名单](https://github.com/jgraph/drawio/blob/f411a11f4f6b8994d869bdbc45f4d4d9e2284f34/src/main/webapp/js/diagramly/EditorUi.js#L42520-L42526) · [插件装载规则](https://github.com/jgraph/drawio/wiki/Plugins#how-plugins-are-loaded)

## 官方 MCP、App 与聊天回传

| 官方入口 | 可用能力与边界 |
| --- | --- |
| MCP App Server | 官方托管入口为 `https://mcp.draw.io/mcp`。本次直接查询 `initialize`、`tools/list` 和 `resources/list`，服务自报 `drawio-mcp-app 1.10.0`，列出 `create_diagram`、`create_semantic_diagram`、`search_shapes`、`get_drawio_reference`。两个生成工具关联 `ui://drawio/mcp-app.html`。常规生成接收 XML 或 Mermaid，快速语义模式接收流程图或泳道图描述。[入口与安装](https://www.drawio.com/mcp/) · [服务端工具文档](https://github.com/jgraph/drawio-mcp/blob/9bd19b362038593bc8611d426c92cd62dc222302/mcp-app-server/README.md) |
| 聊天内 App | 兼容宿主用沙箱 iframe 加载 draw.io viewer，支持缩放、平移、图层和全屏。复制与下载取决于宿主能力。通过 “Open in draw.io” 打开完整编辑器。官方列出 Claude、ChatGPT、VS Code 的 GitHub Copilot、Cursor 等入口，缺少内联渲染的客户端可以拿到打开图稿的链接。[App 工作方式](https://github.com/jgraph/drawio-mcp/blob/9bd19b362038593bc8611d426c92cd62dc222302/mcp-app-server/README.md#L1-L28) · [客户端说明](https://www.drawio.com/docs/manual/generate/drawio-mcp-server/) |
| MCP Tool Server 与助手插件 | `@drawio/mcp` 的 stdio 工具可从 XML、Mermaid 或 CSV 打开浏览器编辑器。所核查版本也有 `list_pages`、`get_page`、`set_page`，可按页读取或修改本地图文件。Claude Code、Codex CLI 和 GitHub Copilot CLI 等可用的官方助手插件重点是生成项目中的 `.drawio` 文件，也可用 Desktop CLI 导出 PNG、SVG 或 PDF。官方还提供 Claude Projects 指令，用于生成打开图稿的链接。这些入口的公开接口覆盖生成、文件或打开图稿，未见读取活动选区的接口。[Tool Server 工具清单](https://github.com/jgraph/drawio-mcp/blob/9bd19b362038593bc8611d426c92cd62dc222302/docs/tool-server-tools.md) · [官方入口比较](https://www.drawio.com/docs/manual/generate/drawio-mcp-server/) |

MCP Apps 规范提供 `ui/update-model-context`（SDK `updateModelContext()`）给后续消息补充上下文，以及 `ui/message`（SDK `sendMessage()`）发起会话消息。能否调用取决于宿主声明的能力。draw.io App 源码用这些接口回传布局检查、适用时的图稿 XML 和截图。用户点修复布局才发起消息。源码也有 ChatGPT 专用的 `setWidgetState` / `sendFollowUpMessage` 分支。这些是 UI 到聊天的现成例证，其数据来自 viewer 中的渲染结果。独立编辑器里的选中元素仍需通过其自身接口取得。[MCP Apps 通信](https://apps.extensions.modelcontextprotocol.io/api/documents/overview.html#bidirectional-communication) · [宿主能力](https://apps.extensions.modelcontextprotocol.io/api/interfaces/app.McpUiHostCapabilities.html) · [发送修复消息](https://github.com/jgraph/drawio-mcp/blob/9bd19b362038593bc8611d426c92cd62dc222302/mcp-app-server/src/shared.js#L3237-L3264) · [文本上下文](https://github.com/jgraph/drawio-mcp/blob/9bd19b362038593bc8611d426c92cd62dc222302/mcp-app-server/src/shared.js#L3328-L3375) · [图像上下文](https://github.com/jgraph/drawio-mcp/blob/9bd19b362038593bc8611d426c92cd62dc222302/mcp-app-server/src/shared.js#L3433-L3456)

ChatGPT 的宿主扩展文档给出了把选中项作为文本附件加入模型上下文的示例。支持该扩展的宿主还可用 `ui/message` 的 `send: false` 写入草稿。若把完整编辑器再嵌入自建 MCP App，需要同时满足外层宿主的 `frameDomains` 和编辑器的 `frame-ancestors`。这些能力取决于实际宿主和来源配置。[OpenAI 上下文扩展](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#uiupdate-model-context-extensions) · [OpenAI 草稿扩展](https://github.com/openai/mcp-extensions/blob/main/docs/spec.md#prompt-target-and-send-behavior) · [MCP Apps 资源规则](https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx#ui-resource-metadata) · [draw.io 自托管嵌入](https://github.com/jgraph/drawio/wiki/Embedding/1a6907f0ad07d660d49d06ea7e17ce45792b8d12#your-own-instance)

## 自托管与内网边界

- **编辑器。** draw.io 官方提供 `jgraph/drawio` Docker 镜像和可离线使用的 Desktop。Docker 的 `offline=1` 关闭云存储支持。Desktop 是独立程序，官方文档给出的 Web 插件扩展方式适用于 Web 编辑器和 Docker。自托管 iframe 的资源、字体、图标及外链是否全部留在内网，要看实际版本、配置和图稿内容。[官方 Docker 文档](https://github.com/jgraph/docker-drawio/blob/d2e740bd73c9c2a397ff1043aef78d3415ad1cc9/README.md) · [离线编辑说明](https://www.drawio.com/docs/security/diagrams-offline/) · [插件支持范围](https://www.drawio.com/docs/reference/plugins/add-plugin/#plugins-not-supported-in-drawio-desktop-or-integrations)
- **MCP App。** Node.js、Docker 或 Cloudflare Workers 可自托管服务。使用公网 MCP 端点时，生成参数会到达该服务。自托管 App 默认仍要从 `viewer.diagrams.net` 加载 viewer，相关图形资产也可能使用公网地址。用 `DRAWIO_BASE_URL` 改的是编辑器链接，`VIEWER_PATH` 可内联 viewer 脚本，`DRAWIO_ICON_SERVICE_URL=off` 可关闭图标查询回退。官方还记录了 viewer 版本检查。编辑器、MCP 服务、浏览器资产和聊天模型各自有网络边界，单独自托管 MCP 服务不足以证明全程断网可用。[官方自托管说明](https://github.com/jgraph/drawio-mcp/blob/9bd19b362038593bc8611d426c92cd62dc222302/mcp-app-server/README.md#self-hosting) · [数据与出网说明](https://github.com/jgraph/drawio-mcp/blob/9bd19b362038593bc8611d426c92cd62dc222302/README.md#L169-L213)

## 相关聊天集成

| 集成 | 已证实的用法与适用范围 |
| --- | --- |
| Excalidraw MCP App | Excalidraw 官方仓库提供 `https://mcp.excalidraw.com`、流式绘图与全屏编辑。其开发文档描述把渲染图的截图回传给模型。开源编辑器 SDK 另有 `getSceneElements`、`getAppState`、`onChange`，可供自建画布读取场景和状态。公开 App 以 Excalidraw 元素为数据模型。选区评论与结构化选区回传仍可见于未合并的提案，不能计为已上线功能。[选区评论提案](https://github.com/excalidraw/excalidraw-mcp/pull/58) · [官方 MCP App](https://github.com/excalidraw/excalidraw-mcp) · [回传说明](https://github.com/excalidraw/excalidraw-mcp/blob/main/CLAUDE.md) · [编辑器 SDK](https://plus.excalidraw.com/docs/sdk/excalidraw/api/props/excalidraw-api) |
| Figma MCP | Figma 桌面 MCP 支持选中框架或图层后，提示客户端对当前选区工作，`get_design_context` 可取得设计上下文。远程 MCP 的对应流程是在提示词中附上选区链接，由客户端提取节点 ID。它是现成的“对象选区供对话引用”交互参照，适用于 Figma 的文档和对象模型。[桌面服务](https://developers.figma.com/docs/figma-mcp-server/local-server-installation/) · [远程选区链接](https://developers.figma.com/docs/figma-mcp-server/remote-server-installation/) · [工具说明](https://developers.figma.com/docs/figma-mcp-server/tools-and-prompts/#get_design_context) |
| Claude Whiteboards / Artifacts | Whiteboards 测试版支持拖框指定白板区域，让 Claude 只围绕该区域回答，是现成的“圈选后提问”交互。官方帮助列出的导出与转交方式包括 PNG、Lucid、Miro 和 Zoho Vani，并说明当前不支持从文件导入白板。Claude 文档或 Markdown Artifact 另有高亮文字后 “Edit with Claude” 的入口。[Claude Whiteboards 官方帮助](https://support.claude.com/en/articles/18324319-get-started-with-claude-whiteboards) · [Claude Artifacts 官方帮助](https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them) |

## 验证范围

编辑器源码证据固定在 [draw.io v32.7.4](https://github.com/jgraph/drawio/tree/f411a11f4f6b8994d869bdbc45f4d4d9e2284f34)，MCP App 源码证据固定在 [drawio-mcp 提交 `9bd19b3`](https://github.com/jgraph/drawio-mcp/tree/9bd19b362038593bc8611d426c92cd62dc222302)。在线 MCP 查询只核实了工具和资源声明。嵌入式选区行为来自官方协议与源码，尚无目标浏览器、Windows 或 DSH 的端到端验证。兼容性仍取决于实际打包版本、iframe 来源、切页和失焦时的选区保留行为，以及聊天宿主支持的上下文接口。

## DSH 候选方案与源码证据

| 方案 | 已有能力 | 接入差异 |
| --- | --- | --- |
| Next AI Draw.io 的 DSH 插件 `@next-ai-drawio/dsh` | 对话调用 MCP 创建、读取和修改图，点击消息里的预览链接，在 DSH 右侧栏打开可手动编辑的 draw.io。现成工具包括 `start_session`、`create_new_diagram`、`get_diagram`、`get_selection` 和按图元 ID 修改的 `edit_diagram`。 | 最接近需求。默认入口是链接加侧栏，需要补上消息内画板入口、左画布右聊天的布局、会话与画板绑定和选区传递。上游 DSH patch 用 `npx -y …@latest`，内网需改为固定版本与本地启动。使用自带的同源 draw.io 资源，直接配置跨源 `DRAWIO_BASE_URL` 会使现成 `get_selection` 失效。 [DSH 插件配置](https://raw.githubusercontent.com/DayuanJiang/next-ai-draw-io/main/packages/dsh-plugin/cordis.patch.yml) · [MCP 工具与同源说明](https://github.com/DayuanJiang/next-ai-draw-io/tree/9534a668e3bd53f9c08aa5b8d2d77f409ccd09d4/packages/mcp-server#readme) |
| `dsh-drawai` | DSH 右侧栏画布，手动编辑、选区感知、对话读写和版本冲突检测。 | 适合作为 DSH 交互与并发处理参考。当前文档的默认文件格式是 `.drawai`，界面打开旧 `.drawio` 时会迁移并保留原件。若要求 draw.io 编辑器和原生文件往返，优先验证 Next AI Draw.io。 [项目说明](https://github.com/fourzkw/dsh-drawai) |
| `dsh-mcp-apps` 加官方 draw.io MCP App | 社区宿主用 DSH 聊天工具槽位渲染沙箱 iframe，官方 App 能在该类界面显示图。 | 上游宿主的已记录冒烟基线为 `0.2.1-rc.5` web profile。本次源码中的桥接声明了 `ui/message` 文本能力，未声明 `ui/update-model-context`。还需分别验证两版目标桌面、官方 App 和离线资源。完整编辑及图元选区仍需额外集成。 [社区宿主说明](https://github.com/katticot/dsh-mcp-apps/tree/5f15b7131b3eff9af1502c8eef18a5d45b81eeb7) · [桥接声明](https://github.com/katticot/dsh-mcp-apps/blob/5f15b7131b3eff9af1502c8eef18a5d45b81eeb7/src/client/McpAppToolView.tsx#L156-L166) |

Next AI Draw.io 的当前活动图保存在 MCP 进程的 `currentSession`，`get_selection` 无画板参数，直接读取活动图。多会话接入时，插件必须隔离 MCP 实例或在同一调度锁内完成选图与操作，并核对 DSH 会话和画板的绑定。否则切换对话后，“把这两个节点改蓝”可能命中另一张图。 [活动图状态](https://github.com/DayuanJiang/next-ai-draw-io/blob/9534a668e3bd53f9c08aa5b8d2d77f409ccd09d4/packages/mcp-server/src/index.ts#L184-L210) · [选区工具实现](https://github.com/DayuanJiang/next-ai-draw-io/blob/9534a668e3bd53f9c08aa5b8d2d77f409ccd09d4/packages/mcp-server/src/index.ts#L1217-L1251)

两版 DSH 的 `tool.call.toolview` 都允许按工具名注册会话内视图，可用于显示建图结果和「进入画布」入口。两版的会话输入契约都有 `captureInsertion` 和 `insertText`，可供需要显式插入选区文本的交互使用。Win10 当前目标 `0.2.1-rc.2` 的草稿初始化契约只有保留或替换，不能依赖后续版本的 `whenDraftExists: 'append'`。 [Win10 工具槽位](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-tool/src/client/contract/slots.ts) · [Win7 工具槽位](https://github.com/factfinding/deepseek-harness/blob/b1d80d6af0ad828937325aa917b06b9b3c6985e2/packages/client/ui-tool/src/client/contract/slots.ts) · [Win10 输入契约](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-conversation/src/client/contract/input.ts#L218-L259) · [Win7 输入契约](https://github.com/factfinding/deepseek-harness/blob/b1d80d6af0ad828937325aa917b06b9b3c6985e2/packages/client/ui-conversation/src/client/contract/input.ts#L218-L269)

## 两栏画布模式

**两版源码都有复用原生聊天的入口。** DSH 的子代理侧栏已通过 `SessionProvider` 绑定一个明确的会话，并用 `conversation.content` 的 `embedded` 模式复用聊天记录和输入框。画布模式可以沿用该组合，把绑定改为画板所属的原会话。现有宿主侧栏的会话内容依赖普通 Conversation 主面板处于选中状态，窄窗口也会关闭它。推荐在现有 `main` 槽位注册一个独立的画布面板，内部用可拖拽分隔条布置左侧 draw.io 和右侧原生聊天，保证聊天滚动或收到新消息时左侧编辑器持续挂载。 [Win10 嵌入实例](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-subagent/src/client/sidebar-chat/index.tsx#L120-L168) · [Win7 嵌入实例](https://github.com/factfinding/deepseek-harness/blob/b1d80d6af0ad828937325aa917b06b9b3c6985e2/packages/client/ui-subagent/src/client/sidebar-chat/index.tsx#L120-L168) · [Win10 布局约束](https://github.com/deepseek-ai/deepseek-harness/blob/687f282e8625c6b8d11ff58211a90524be2e4317/packages/client/ui-layout/README.md#L59) · [仓库已有主面板注册](../../src/bootstrap/client.js)

**框选后直接输入。** 左侧选区变化同步到画布插件，在右侧输入框上方显示选中数量。用户按 Enter 或点击发送时，把当前画板、页、图元 ID 与修订号作为该轮的选区快照。文本输入、焦点切换和模型输出期间，左侧画布与选区都应保持可见。右侧使用同一会话的历史、草稿和运行状态。提交时如何将快照与原生发送绑定，需要用两版输入契约做原型验证。第一轮原型也可由模型通过绑定到该画板的工具读取当前选区，以先验证直接对话改图。 [Next AI Draw.io 选区工具](https://github.com/DayuanJiang/next-ai-draw-io/blob/9534a668e3bd53f9c08aa5b8d2d77f409ccd09d4/packages/mcp-server/src/index.ts#L1217-L1251)

## 推荐的最小实现

1. **先复用绘图运行时。** 固定候选 `@next-ai-drawio/mcp-server@0.4.15`，由能力中心交付 DSH 插件、运行时依赖和同源编辑器静态资源，使用已核实的本地 Node 入口启动。把 `@next-ai-drawio/dsh@0.1.0` 作为接入参考。已抽查 npm tarball，内有 draw.io `v32.0.2` 与预览 shell，压缩包约 15 MiB。先跑通侧栏工具链，确认手工修改能被 `get_diagram` 读到，单选、多选能被 `get_selection` 读到。 [DSH 插件发布元数据](https://registry.npmjs.org/@next-ai-drawio%2Fdsh/0.1.0) · [服务发布元数据](https://registry.npmjs.org/@next-ai-drawio%2Fmcp-server/0.4.15)
2. **从建图消息进入两栏模式。** 工具返回画板 ID 和显示数据，消息卡片提供「进入画布」入口。进入后左侧挂载编辑器，右侧嵌入原会话。图稿绑定工作区、会话和画板 ID，保存原生 `.drawio` 与修订号。退出返回普通聊天，重新打开时按画板 ID 取预览地址。
3. **按选区更新原图。** 用户框选后直接在右侧发指令，模型按该轮绑定的图元 ID 写入。校验修订号，检测到手动并发修改时先重读相关内容，避免用旧快照覆盖手动变更。两张图同时打开或两个图元同名时，用画板 ID 和图元 ID 区分。
4. **在两版实机分别验收。** Windows 10 x64 的 `0.2.1-rc.2` 和 Windows 7 x64 的 `0.2.1-rc.5-win7` 都完成「自然语言建图 → 进入两栏画布 → 手动拖动 → 框选两个节点后直接在右侧发指令 → 左侧实时更新 → 退出并重开检查原图和聊天」；再验证切换会话、已有草稿、保存与导出、无公网 DNS 或出网时加载图形库。同时验证聊天流式更新和窗口调整时，画布始终留在左侧。 [目标环境](../../DESIGN.md#内网终端环境)

本次结论来自上游文档、代码和 npm 制品元数据，目标 Windows 宿主、断网运行和工具视图的嵌入效果仍待实机验证。
