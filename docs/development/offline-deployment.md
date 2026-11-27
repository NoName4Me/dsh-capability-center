# 管理台部署与联调

本地 Node 24、pnpm 10.18.3。无需部署任何制品私服。

```sh
git pull
pnpm install --frozen-lockfile --ignore-scripts
pnpm pack:target auto-continue
pnpm dev
```

默认本地管理台 http://127.0.0.1:8780/，临时令牌在开发启动终端显示。打开管理台上传 dist-independent/auto-continue 中的 .upload.zip，确认草稿详情，点击发布。DSH 侧栏进入能力中心并刷新；检查安装、激活、去使用、卸载及重启恢复。测试第二个新能力和新版本是否出现红点。

独立部署使用 DSH_ADMIN_TOKEN、DSH_ADMIN_DATA、DSH_ADMIN_HOST、DSH_ADMIN_PORT。测试允许 DSH_ALLOW_UNSIGNED_CATALOG=1；生产删除该选项，生成 Ed25519 私钥，并让终端信任公钥：

```sh
openssl genpkey -algorithm ED25519 -out catalog-private.pem
openssl pkey -in catalog-private.pem -pubout -out catalog-public.pem
chmod 600 catalog-private.pem
export DSH_CATALOG_SIGNING_KEY_FILE="$PWD/catalog-private.pem"
pnpm start:admin
```

终端设置 DSH_CATALOG_URL 和 DSH_CATALOG_PUBLIC_KEY_FILE，受控 HTTPS；不要给终端管理令牌。数据目录包括 catalog.sqlite（WAL）、packages、uploads，需要一起备份；停止写入或使用一致性快照。管理台默认本机监听，生产反向代理/网络访问控制由部署侧配置。

验收顺序：无依赖插件、OCR（随包 npm 依赖和模型）、Office（包内 wheel）、组合引用、Core 上传更新、撤回和失联缓存。用实际 DSH Mac/Win10/Win7、干净 profile 和空 pnpm 缓存，阻断公网；检查请求日志与真实激活。构建能力时可预先在受控机器下载依赖，但上传后的安装不需要私服。任何未通过实机验收的平台不得标记已支持。
