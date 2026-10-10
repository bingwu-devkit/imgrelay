# ImgRelay 开发与发布

用户安装与使用见 [README](../README.md)，命令和输出约定见 [CLI 参考](./cli-reference.md)。

## 从源码运行

需要 Node.js 22.20+（22.x）或 24.x，以及 pnpm 11.15.1。在仓库根目录运行：

```bash
pnpm install
pnpm build
node packages/cli/dist/index.mjs --help
```

未全局安装 CLI 时，可将使用示例中的 `imgrelay` 替换为 `node packages/cli/dist/index.mjs`。
从本地源码安装 Skill：

```bash
npx skills add ./skills --skill imgrelay
```

CLI 和 Skill 分别安装，构建不会改动 Codex 的配置。

## 仓库结构与文档维护

| 路径                        | 职责                                               |
| --------------------------- | -------------------------------------------------- |
| `packages/core`             | 用户级配置、模型查询、协议调用、能力校验和图片保存 |
| `packages/cli`              | CLI 命令、交互配置与 JSON 输出                     |
| `skills/imgrelay/SKILL.md`  | Codex 的生图执行与结果处理指令                     |
| `examples/basic`            | 使用 core 的本地模拟调用示例                       |
| `scripts/package-smoke.mjs` | 独立打包、安装和命令入口验证                       |
| `docs/cli-reference.md`     | 当前 CLI 行为与配置参考                            |

维护根目录的 `README.md` 即可。CLI 构建会自动复制 README 和许可证到 `packages/cli/`，
这两份副本不纳入 Git。npm 包只包含构建产物、README 和许可证，因此根 README 中的详细
文档链接使用 GitHub URL，避免在 npm 页面或安装目录中失效。

## 验证

```bash
pnpm check
node scripts/package-smoke.mjs
```

`pnpm check` 依次执行格式检查、构建、lint、类型检查与测试。
测试使用本地模拟中转站和真实 CLI 子进程，不消耗真实 API 额度。
打包安装检查在临时目录中验证发布包可以独立安装并运行。

CI 在 Node.js 24 上执行静态检查，并在 Windows、Linux、macOS 与 Node.js 22、24 的组合上
运行测试、包检查、基础示例和独立打包安装检查。测试覆盖凭据存储和输出脱敏；
配置文件本身不提供权限保护或加密。

### Skill 检查

在仓库根目录检查 Skills CLI 能否发现 Skill：

```bash
npx skills add ./skills --list
```

CI 使用固定版本的 Skills CLI 执行发现检查。修改 Skill 后，还可在已安装 skill-creator 的环境中
运行其 `scripts/quick_validate.py`，检查 frontmatter、命名和未完成占位内容：

```bash
python /path/to/skill-creator/scripts/quick_validate.py skills/imgrelay
```

结构校验不代表执行行为正确，需同时审阅提示词传递、配置选择、等待进程和失败处理指令。
真实中转站生成需用户明确要求并提供凭据来源，不作为自动测试的一部分。

## 发布

自动发布使用 npm Trusted Publishing。首次配置需在 npm 中关联此 GitHub 仓库和
`.github/workflows/release.yml`，并允许 GitHub Actions 创建 PR。

1. 修改需要发布的 CLI 或 core 后，运行 `pnpm changeset` 记录版本变化。
2. 将 changeset 合入 `main`，发布工作流创建或更新版本 PR。
3. 合并版本 PR 后，工作流完成验证并发布 npm 包和 GitHub Release。

发布工作流的提交信息使用简体中文。CLI 构建将私有 core 打入发布包，
独立打包安装检查确保发布依赖不泄漏 `@imgrelay/core`。
