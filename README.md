# starter-ts

一个有明确工程取向的 TypeScript 库模板：使用 pnpm 管理 workspace，Turborepo 编排任务，
Oxlint 负责代码检查和规则修复，Oxfmt 统一格式化仓库，tsdown 构建 ESM 包，Vitest 测试真实
行为，Changesets 管理发布。

## 特性

- Node.js ESM only，支持 Node.js 22.18+ 与 24.x
- `packages/core`：可发布的 TypeScript 库
- `examples/basic`：直接消费 workspace 包的最小示例
- 根目录统一维护 Oxlint、Oxfmt 与 TypeScript 公共配置
- 根级 Oxlint 类型感知检查与 Oxfmt 统一格式化，子包无需重复配置
- Turborepo 本地及 CI 缓存
- Changesets、npm Trusted Publishing 和 GitHub Release
- Ubuntu、Windows 与 Node.js 22、24 的 CI 验证

## 从模板开始

通过 GitHub 的 **Use this template** 创建仓库后，先完成以下替换：

1. 将 `@scope/core` 替换为你的 npm 包名。
2. 将 `@scope/example-basic` 替换为你的示例 workspace 名称。
3. 将 `YOUR_NAME` 替换为你的作者名。
4. 将 `OWNER/REPOSITORY` 替换为你的 GitHub 仓库路径。
5. 更新根目录 `package.json` 和 `.changeset/config.json` 中的
   `BINGWU2003/starter-ts`。
6. 修改 `packages/core` 的描述、源码和测试。

可以使用 `rg` 检查是否还有未替换的标记：

```bash
rg '@scope|YOUR_NAME|OWNER/REPOSITORY|BINGWU2003/starter-ts'
```

## 目录结构

```text
.
├─ packages/
│  └─ core/            # 可发布库，只保留构建、测试与 TypeScript 项目配置
├─ examples/
│  └─ basic/           # 消费示例，只保留 TypeScript 项目配置
├─ .npmrc              # npm/Node.js 引擎严格校验
├─ oxlint.config.ts    # 整个仓库共享的 Oxlint 配置
├─ oxfmt.config.ts     # 整个仓库共享的 Oxfmt 配置
├─ tsconfig.base.json  # TypeScript 公共编译选项
├─ tsconfig.node.json  # Node.js workspace 的 TypeScript 配置
└─ turbo.json          # 只负责任务编排与缓存
```

Oxlint 与 Oxfmt 都直接从根目录执行并检查整个仓库，子包不提供对应的配置或 scripts。
TypeScript 的公共选项也位于根目录，各 workspace 的 `tsconfig.json` 只声明自己的源码范围和
必要覆盖项。构建入口、测试环境等只属于单个包的配置仍留在对应 workspace；Turbo 只编排
构建、测试与类型检查等包级任务。

## 开发

需要 Node.js 22.18+ 或 24.x，以及 Corepack 提供的 pnpm 11.15.1。`.npmrc` 与
`pnpm-workspace.yaml` 会严格校验 `package.json` 声明的 Node.js 和 pnpm 版本：

```bash
corepack enable
pnpm install
pnpm check
```

常用命令：

| 命令                | 用途                                  |
| ------------------- | ------------------------------------- |
| `pnpm build`        | 构建所有 workspace                    |
| `pnpm dev`          | 以监听模式运行开发任务                |
| `pnpm lint`         | 使用根配置检查整个仓库                |
| `pnpm lint:fix`     | 使用根配置修复整个仓库的 lint 问题    |
| `pnpm format`       | 使用根 Oxfmt 配置格式化整个仓库       |
| `pnpm format:check` | 检查整个仓库的格式                    |
| `pnpm typecheck`    | 检查所有 workspace 的 TypeScript 类型 |
| `pnpm test`         | 运行 Vitest 测试                      |
| `pnpm check`        | 运行提交前的完整验证                  |

提交时，nano-staged 会使用根 `oxlint.config.ts` 修复暂存的 JavaScript/TypeScript 文件，再用
根 `oxfmt.config.ts` 格式化所有匹配文件。

运行消费示例：

```bash
pnpm build
pnpm --filter @scope/example-basic start
```

## 发布

模板默认不启用自动发布：未设置仓库变量 `ENABLE_RELEASE=true` 时，Release workflow 的
发布任务会跳过，不会创建版本 PR、发布 npm 包或创建 GitHub Release。CI 验证仍正常运行。

### 启用自动发布

从模板创建项目并替换包名、仓库信息后，按以下步骤配置：

1. 首次发布需要先在本地登录 npm 并创建包，将以下命令中的包名替换为你的实际包名：

   ```bash
   pnpm --filter @your-scope/your-package publish --access public
   ```

2. 在 npm 包的 **Trusted Publisher** 设置中绑定 GitHub 仓库和工作流文件 `release.yml`。
   工作流使用 OIDC 发布，不需要长期保存 `NPM_TOKEN`。
3. 在 GitHub 仓库的 **Settings → Actions → General → Workflow permissions** 中启用
   **Allow GitHub Actions to create and approve pull requests**，以便 Changesets 创建版本 PR。
4. 在 **Settings → Secrets and variables → Actions → Variables** 中添加仓库变量
   `ENABLE_RELEASE`，值设为 `true`。

变量启用后，下次推送到 `main` 就会执行发布流程。删除变量或将值设为 `false` 可再次停用。

### 日常发布

面向用户的变更应先创建 changeset：

```bash
pnpm changeset
```

合并到 `main` 后，Release workflow 会创建或更新版本 PR。合并版本 PR 后，workflow 会构建、
发布 npm 包，并由 Changesets 创建 GitHub Release。

## Turbo 远程缓存

默认只使用本地缓存。如果团队需要共享缓存，可以按需连接远程缓存：

```bash
pnpm turbo login
pnpm turbo link
```

仓库不会预设 Vercel 账户或远程缓存密钥。

## 新增 workspace

新增普通子包时：

1. 让子包的 `tsconfig.json` 继承根目录 `tsconfig.node.json`，再声明自己的 `include`、
   `rootDir` 和必要覆盖项。
2. 按需提供 `typecheck`、`test`、`build` 等包级 scripts，Turbo 会按同名任务自动编排。
3. 不要添加子包级 Oxlint、Oxfmt 配置或 scripts；根目录命令会自动覆盖新增 workspace。
4. 构建入口、测试环境等局部决策留在使用方，不需要的工具不必创建配置。

## 许可证

[MIT](./LICENSE.md)
