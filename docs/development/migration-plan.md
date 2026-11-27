# 实施与验收

当前 master 采用离线能力包上传；archive/private-registry 保存之前私服实现。保留目录同步、签名、安装账本、回滚和独立构建。旧全量静态分发仅作开发预览及回归夹具，不再作为生产发布入口。

- 上传协议：管理员上传 ZIP，解析、依赖和摘要校验，草稿/发布/下架/撤回，核心独立索引。
- 官方能力：独立构建生成上传 ZIP，OCR 携带 npm 闭包，Office 携带 pypdf wheel 并继承 DSH 内置 Office 库。
- 第三方：SDK pack/inspect，支持插件、Skill、资源和固定能力组合。
- 目标验收：真实 Mac、Win10、Win7 DSH 的空缓存、断公网安装、失败回滚、升级、卸载、MCP 生命周期、Python ABI、组合引用及权限；CI 不能代替实机结果。

不把旧的私服导入接口、仓库连接凭据或运行时 registry 配置迁回 master。
