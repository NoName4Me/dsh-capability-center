# DSH 能力中心

面向内网 DSH 的能力发现、安装、更新和管理。自本次架构调整起，**所有能力统一以 ZIP 通过管理台上传并发布**。不部署 Nexus、Verdaccio、PyPI 或 Raw 私服；能力安装不从公网补齐依赖。

## 开发启动

需要 Node.js 24、pnpm 10.18.3、Python 3（用于构建）、实际 DSH CLI。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm dev
```

开发启动器构建中心引导插件，启动本地管理台（默认 8780，终端显示临时管理员令牌），将引导插件离线安装到隔离的 DSH Web profile，打开 DSH Web（默认 4174）。进入侧栏能力中心；在管理台上传并发布后，终端刷新目录。使用 `DSH_CATALOG_URL` 可连接外部管理台；本地开发数据保存在 .dev/admin-data 与 .dev/dsh-home。原全量静态分发仅作为自动化回归和 UI 预览夹具，不是发布入口。

## 独立打包

```sh
pnpm pack:target center
pnpm pack:target auto-continue
pnpm pack:target offline-ocr
pnpm pack:target drawio
pnpm pack:target office-enhancement
pnpm pack:target genui
```

每项生成 dist-independent/<目标>/*.upload.zip，直接在管理台选择上传、检查声明、发布。中心的 packages/capability-center-0.3.0.tgz 是首次引导安装的 DSH 原生文件；后续核心更新通过 center 的上传 ZIP 发布。第三方能力参见 [离线能力包协议](docs/architecture/target-design.md)，一般使用 `pnpm pack:capability capability.json output.zip`。

## 独立部署管理台

```sh
export DSH_ADMIN_TOKEN="$(openssl rand -hex 32)"
export DSH_ADMIN_DATA="$HOME/dsh-capability-admin"
# 仅本机联调可显式允许未签名目录
export DSH_ALLOW_UNSIGNED_CATALOG=1
pnpm start:admin
```

管理台默认绑定 127.0.0.1:8780，生产部署使用可信 HTTPS 及 Ed25519 签名、持久存储和受控终端访问。终端设置 DSH_CATALOG_URL 指向管理台分发地址，不需要管理令牌。详见 [部署与联调](docs/development/offline-deployment.md)。

## 验证

```sh
pnpm typecheck
pnpm test:packages
# 原有全量回归需要 Python Office 测试依赖
pnpm test
```

真实 DSH 的原生插件管理、Win10/Win7、空 pnpm 缓存和断公网验证仍需在目标机执行。中心包代码没有提供公网依赖回退；DSH 自身配置、作用域 registry 和网络策略也必须验证。历史私服设计保留在 archive/private-registry 分支。

[完整文档索引](docs/README.md)
