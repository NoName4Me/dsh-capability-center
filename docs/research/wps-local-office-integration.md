# WPS 本地办公集成评估

核对日期：2026-11-18。场景：Windows 内网台式机、DSH 0.2.1-rc.2、无互联网，能力中心提供 PDF、Word、Excel、PPT 通用办公能力。

## 结论与范围

WPS 提供客户端自动化与应用集成接口，可以成为可选的本地执行后端。但“电脑安装了 WPS”不足以证明可从 DSH 调用；需要验证实际版本、接口开放情况和离线运行条件。本轮没有内网 Windows WPS 实测。

用户明确表示：如果集成复杂或能力不足，可以不用 WPS。首版基础办公能力不以 WPS 为依赖，优先复用 DSH 自带的库和文档引擎。

## 官方证据

1. [WPS 客户端开发概述](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-client-dev-introduction) 列出 JS 加载项、宏、C++/Java 应用集成等方案。它们是不同的集成通道，不能混同为某个版本均可调用的通用接口。
2. [C++ 应用集成概述](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/c-app-integration-wps-guide/c-app-integration-overview) 明确支持进程内与进程外方案；进程外程序可启动 WPS 并执行任务。
3. [CreateObject](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/macro-editor-api/function/createobject) 给出文字、表格、演示的应用标识。该页介绍宏环境下的跨进程对象创建，不能单独证明所有安装版本均向外部 PowerShell 注册 COM。
4. [Document.ExportAsFixedFormat](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/wps/Document/member/ExportAsFixedFormat) 提供文档导出 PDF/XPS 的接口。
5. [表格 Application](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/jsapi/et/Application/obj) 提供工作簿、单元格访问和公式重算等接口。这证明对象模型有相应功能，不代表已验证 DSH 外部调用。
6. [加载项开发说明](https://open.wps.cn/documents/app-integration-dev/wps365/client/wpsoffice/wps-integration-mode/wps-addin-development/wps-addin-development-instructions) 介绍 publish 部署与离线压缩包模式，并明确版本支持条件；不能把加载项当成一个直接装入 DSH 即可运行的普通网页。
7. [PowerShell New-Object](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/new-object) 提供 Windows COM 对象创建机制。外部 PowerShell 调用 WPS 的可行性仍取决于 WPS 是否在目标机器注册并支持对应的 COM 接口。

## 两种适用方式

| 方案 | 适用范围 | 额外工作 |
|---|---|---|
| DSH 插件调用本机自动化接口 | 对指定文件副本执行转换、重算、模板填充等批处理 | 检测版本与接口、参数封装、任务串行、超时、错误反馈与进程清理 |
| WPS JS 加载项与 DSH 桥接 | 与正在打开的文档、当前选择区域交互 | 额外部署 WPS 加载项、建立本机通信、维护两侧生命周期与兼容性 |

以上为根据官方接口推导的集成设计，尚未实施或通过目标 Windows 版本验收。COM 进程外自动化与 COM 加载项是不同机制，不把加载项认证规则直接套到所有外部自动化场景。

## 建议

- PDF、Word、Excel、PPT 入口保持与具体办公软件解耦。
- 基础读写和批量处理先使用 DSH 已打包的离线环境。
- 只有在原应用排版、特定公式或旧格式方面出现明确需求与差异时，再评估 WPS 增强后端。
- WPS 确有价值时，先验证少量指定文件的操作，不以控制用户当前活动窗口作为首版基础。
- WPS 的 PDF 导出接口不能代表所有 PDF 编辑、OCR 或云端服务均可离线自动化。
- 目标机未验证前，产品不显示“WPS 已就绪”，也不将 WPS 作为四项能力的必装依赖。
