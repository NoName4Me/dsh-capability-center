# 内网私服联调（macOS 优先）

状态：实施准备，未实际执行。私服地址及账号由部署者提供，本文所有地址为示例，不是已部署服务。

## 私服侧

优先 Nexus Repository；Mac mini 可先用独立服务或容器验证，生产部署另行评估，不强制 Docker。确认所用 Nexus 发行版/授权支持 npm、PyPI、Raw 及预计组件数/请求量。依据实际版本配置如下 hosted 仓库（名称可调整）：

| 仓库 | 作用 | 读取端点示例 |
| --- | --- | --- |
| npm-internal | 已批准 DSH Bundle 与 npm 依赖 | https://nexus.example.internal/repository/npm-internal/ |
| pypi-internal | 已批准 wheel | https://nexus.example.internal/repository/pypi-internal/simple/ |
| dsh-assets | 资源、Skill ZIP、核心制品 | https://nexus.example.internal/repository/dsh-assets/ |

测试仓库与正式仓库分开，测试端使用单独配置。研发/发布账号可上传，终端仅可读；版本不可重复部署；私服或反向代理配置可信 TLS，测试允许显式本地 HTTP 但不得带生产凭据。内网无公网时不能依赖 proxy miss 回源。先提供连通性、读写验证结果、目标仓库 URL、是否需要认证、证书链与 Mac DSH 版本；不要提交 token。

## 原生发布验证

用无实际业务数据的测试包。npm Bundle 按目标 DSH 官方规范定义，声明一个固定版本 npm 依赖及其传递依赖。先引入完整依赖闭包，再 npm publish；Python 先引入与目标 Python/OS/arch 匹配的 wheel，再 twine upload。Raw 用私服支持的上传方式。以下是占位命令，实际路径与凭据需配置：

```sh
npm ping --registry "$DSH_NPM_REGISTRY"
npm view "$DSH_TEST_BUNDLE" version --registry "$DSH_NPM_REGISTRY"
npm publish --registry "$DSH_NPM_REGISTRY"
python3 -m twine upload --repository-url "$DSH_PYPI_UPLOAD" dist/*.whl
curl --fail --head "$DSH_RAW_BASE/fixtures/hello.zip"
```

pip 的 simple 索引 URL 和 twine 上传 URL 不是同一地址。若引入外部依赖，保留来源、许可证、哈希、解析结果与审批证据；不得通过执行第三方安装脚本来获取未经审批的制品。原生包脚本、Git/HTTP 依赖、平台可选依赖均要检查。隔离测试的 npm/pnpm store、DSH profile、pip 缓存必须为空；验证过程阻断所有公网出口而不是仅拔掉 Wi-Fi。保留内网私服与必要 DSH 测试模型的访问；安装过程不需要模型。

## 实验矩阵

先 Mac mini（记录 CPU 架构、macOS、真实 DSH、Node/pnpm/Python 版本），然后目标 Win10 x64 0.2.1-rc.2、Win7 x64 0.2.1-rc.5-win7。每项记录：环境、私服类型、测试包版本、步骤、实际结果/日志（脱敏）、是否访问公网、通过/失败/未执行。以下均未执行私服联调。

| ID | 实验与通过条件 | Mac | Win10 | Win7 |
| --- | --- | --- | --- | --- |
| V01 | 原生 installBundle 指定私服；空缓存完整获取多级依赖；listBundles 显示精确版本 | 待验 | 待验 | 待验 |
| V02 | 同名 Bundle v1→v2；记录是否直接替换、applied/restart-required、实际激活 | 待验 | 待验 | 待验 |
| V03 | 缺依赖、损坏或激活失败；验证 profile/账本恢复、旧版可用；卸载不删外部包 | 待验 | 待验 | 待验 |
| V04 | Bundle 注册 Skill / 原生 Skill ZIP；安装、更新、卸载均能从真实 registry 验证 | 待验 | 待验 | 待验 |
| V05 | 远程 HTTP MCP 注册、调用无副作用工具、卸载移除连接和工具 | 待验 | 待验 | 待验 |
| V06 | 本地 Node stdio MCP 启动使用已装入口；卸载停止所属进程 | 待验 | 待验 | 待验 |
| V07 | DSH 实际 Python 创建 venv、从内网 pip 安装锁定 wheel；隔离、更新、卸载及重启验证 | 待验 | 待验 | 待验 |
| V08 | Raw 大文件、SHA256 不符、网络中断；缓存复用及安全解包 | 待验 | 待验 | 待验 |
| V09 | 官方市场自定义索引与目标版本兼容；自定义能力目录同步、上新、已读、更新、ETag/304、离线缓存 | 待验 | 待验 | 待验 |
| V10 | Bootstrap/Core 检查、下载、激活、失败回退；旧目录 schema 不影响核心检查 | 待验 | 待验 | 待验 |
| V11 | 断公网，验证 DNS/请求日志无外部 registry、Git URL、二进制下载；内网 TLS/证书链可用 | 待验 | 待验 | 待验 |

V01–V03、V11 是 npm 迁移前置门禁；V07 决定 Python adapter 细节，若 Win7 venv/ABI 不可用，可为该平台提供预制运行环境或明确不支持对应能力，不能回退为随意修改宿主 Python。Mac 先跑通流程，但不替代目标 Windows 验收。

## 配置约定（拟议）

联调环境用被 git 忽略的 .env.local 或运行时环境变量。提交 .env.example 时只放键和占位值。建议 DSH_NPM_REGISTRY、DSH_PYPI_INDEX、DSH_PYPI_UPLOAD（仅发布侧）、DSH_RAW_BASE、DSH_CATALOG_URL、DSH_TEST_BUNDLE；后续具体实现统一映射。私服未就绪时使用内存/本地 mock 测试协议；不得将 mock 通过视为真实宿主通过。