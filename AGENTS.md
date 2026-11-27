# Repository Guidelines

- 提交信息遵循 Conventional Commits，类型后的描述使用中文。
- 开发或验证能力时，参照 [内网终端环境](DESIGN.md#内网终端环境)中的 Windows 和 DSH 版本对应关系。

- 私服版与 monorepo 迁移遵循 [目标架构](docs/architecture/target-design.md) 与 [迁移计划](docs/development/migration-plan.md)；未通过 [联调矩阵](docs/development/registry-integration.md) 的功能不得标注为实机已验证。
- 官方能力独立构建、版本与发布；禁止在客户端实现 pnpm/pip 已提供的依赖求解，禁止提交私服凭据。
