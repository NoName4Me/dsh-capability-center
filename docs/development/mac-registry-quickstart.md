# Mac 私服联调快速开始

当前为 0.3.0 联调代码，不是正式生产发布。建议 Node.js 24、pnpm 10.18.3、Python 3.12、DSH 0.2.2-rc.3。私服先建 npm hosted、PyPI hosted、Raw hosted 三个仓库，实际名字可替换。上传账号与终端只读账号分离，部署时关闭所有公网 fallback，网络层也禁止外网出口。

## 1. 本地准备
```sh
git pull
npm install -g pnpm@10.18.3
pnpm install --frozen-lockfile --ignore-scripts
npm run test:registry
npm run pack:target -- center
npm run pack:target -- auto-continue
```

独立制品输出到 dist-independent/<目标>/，不会重建其他官方能力；根 npm run build 仍构建完整离线包。建议先测试无额外依赖的自动续跑。

## 2. 配置私服和后台
在启动后台的 shell 中设置变量（以下为示例地址，不要把真实令牌提交到 Git）：
```sh
export DSH_NPM_REGISTRY=http://127.0.0.1:8081/repository/npm-hosted/
export DSH_PYPI_INDEX=http://127.0.0.1:8081/repository/pypi-hosted/simple/
export DSH_RAW_BASE=http://127.0.0.1:8081/repository/raw-hosted/
export DSH_ADMIN_TOKEN="$(openssl rand -hex 32)"
export DSH_ADMIN_DATA="$HOME/dsh-capability-admin"
export DSH_ADMIN_PORT=8780
export DSH_ALLOW_UNSIGNED_CATALOG=1
npm run start:admin
```
打开 http://127.0.0.1:8780/，输入上述管理令牌。默认仅绑定 loopback。npm/Raw 若限制读取，后台读取 Bearer token 由 DSH_NPM_READ_TOKEN / DSH_RAW_READ_TOKEN 提供；Nexus 的实际认证模式需验证，首轮建议本机隔离环境开启匿名只读。npm 发布使用专用 npmrc / 登录认证，后台凭据不用于发布。PyPI 的上传路径与 simple 索引路径不同。

正式部署应使用 HTTPS 和 Ed25519 签名，删除 DSH_ALLOW_UNSIGNED_CATALOG：
```sh
openssl genpkey -algorithm ED25519 -out catalog-private.pem
openssl pkey -in catalog-private.pem -pubout -out catalog-public.pem
export DSH_CATALOG_SIGNING_KEY_FILE="$PWD/catalog-private.pem"
```
私钥只在后台，公钥通过企业部署配置下发终端，设置 DSH_CATALOG_PUBLIC_KEY_FILE。私钥文件权限仅发布管理员可读。切换公钥或目录源需按企业流程部署，不允许随意重置目录 revision。

## 3. 上传及发布第一个能力
使用已具备上传权限的 npm 配置：
```sh
npm publish dist-independent/auto-continue/packages/dsh-intranet-auto-continue-1.2.0.tgz --registry "$DSH_NPM_REGISTRY"
```
在后台导入 npm 包 dsh-intranet-auto-continue，精确版本 1.2.0，核对草稿并发布。后台不会自动发布任意 npm 包；目录里只有人工确认过的版本。终端读取 /catalog.json，不使用后台管理令牌。

## 4. 启动真实 DSH Web 进行联调
在另一个终端设置相同的 npm 与 PyPI URL，以及目录地址：
```sh
export DSH_NPM_REGISTRY=http://127.0.0.1:8081/repository/npm-hosted/
export DSH_PYPI_INDEX=http://127.0.0.1:8081/repository/pypi-hosted/simple/
export DSH_CATALOG_URL=http://127.0.0.1:8780/
npm run dev
```
dev 命令使用隔离 DSH_HOME，会构建旧离线分发作为开发保底，但页面配置优先读取 DSH_CATALOG_URL。侧栏进入能力中心，确认内网目录、安装自动续跑并检查宿主激活状态。首次目录建立基线；随后发布新能力，手动刷新或等待轮询验证上新红点、已读和更新状态。关闭目录服务，验证已有安装仍可管理，不能据旧缓存安装新版本。生产签名模式另在该 shell 设置 DSH_CATALOG_PUBLIC_KEY_FILE。

## 5. 其他独立能力
```sh
npm run pack:target -- offline-ocr
npm run pack:target -- drawio
npm run pack:target -- genui
npm run pack:target -- office-enhancement
```
- OCR npm 版 0.2.0：模型随制品，Node 依赖 tesseract.js 7.0.0、image-size 2.0.2 及传递依赖必须先放入内网 npm。旧离线版使用不同版本 0.2.0-offline.1，防止同版本不同内容。
- draw.io 0.2.0：同源前端资产仍随 Bundle 打包。
- GenUI：保持上游固定版本的离线重打包，不属于本团队自主实现。导入时可通过管理 API overlay 指定原目录 ID dsh-genui。需核对 npm 名称、版本是否与已发布制品冲突。
- Office 增强 1.1.0：上传 dist-independent/office-enhancement/skills/office-enhancement/1.1.0/ 下两个文件到 Raw 同名路径；将 packages/pypdf-7.1.0-py3-none-any.whl 上传 PyPI（例如用经过配置的 twine），后台导入 Raw Skill 声明 skills/office-enhancement/1.1.0/capability.json。终端按锁定版本/哈希从 PyPI 安装独立环境，继承 DSH 已有 Office 库。旧 composite 类型需先卸载再安装，不自动覆盖旧实现。实际 venv 和宿主 Python 兼容性尚待验证。
- 核心：独立构建的 dist-independent/center/ 下 core/ 和 core-release-index.json 上传至 Raw 同名路径。先上传 ZIP，再发布索引。初次终端引导 TGZ 可经 DSH 原生插件入口安装。独立构建不会维护线上历史索引；正式升级时应先读取并保留既有 release index，使用 tools/publish.mjs core 维护发布历史。

## 验收边界
自动化测试不能代替真实 DSH pluginManager/内网 pnpm/venv 的验证。实际私服访问、MCP Bundle 本地/远程连接、Win7/Win10、TLS、企业身份及授权、闭包依赖准入、安全扫描与核心生产发布流程仍需联调或完善。不要把本地 HTTP 和单 token 模式部署到生产网络。
