# Changesets

按[发布说明](../docs/development.md#发布)配置 npm Trusted Publisher 和 GitHub 权限。
发布流程会在每次向 `main` 推送时运行。

运行 `pnpm changeset` 描述面向用户的变更。合并到 `main` 会维护版本 PR；
合并版本 PR 后会发布 npm 包并创建对应的 GitHub Release。
