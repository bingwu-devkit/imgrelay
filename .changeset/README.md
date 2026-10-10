# Changesets

模板默认跳过自动发布。按[发布说明](../README.md#发布)配置 npm 和 GitHub 权限，并设置
GitHub 仓库变量 `ENABLE_RELEASE=true` 后，发布流程才会启用。

运行 `pnpm changeset` 描述面向用户的变更。启用发布后，合并到 `main` 会维护版本 PR；
合并版本 PR 后会发布 npm 包并创建对应的 GitHub Release。
