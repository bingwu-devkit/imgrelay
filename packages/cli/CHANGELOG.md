# imgrelay

## 0.3.0

### Minor Changes

- [`0be8864`](https://github.com/bingwu-devkit/imgrelay/commit/0be8864ff46d6e8c715114a05c22f41cf71667a9) Thanks [@BINGWU2003](https://github.com/BINGWU2003)! - 移除 `generate --prompt`，统一使用互斥的 `--prompt-file` 和 `--prompt-stdin`，避免 Windows 启动脚本截断多行及长提示词。严格读取 UTF-8，去除开头一个编码 BOM，其余文本原样保留。

  新增无需密钥、完全只读的 `generate --dry-run`，预览原始提示词 SHA-256、UTF-16 字符数、UTF-8 字节数、有效请求配置和参数来源；正式结果及生成记录增加同样的完整性元数据。同步 Windows 使用示例、CLI 参考和仓库 Skill，并增加离线 mock 与安装入口回归。

## 0.2.1

### Patch Changes

- [`84a4b5a`](https://github.com/bingwu-devkit/imgrelay/commit/84a4b5a905c8424b31e46acdf1e796b989adb21f) Thanks [@BINGWU2003](https://github.com/BINGWU2003)! - 优化 README 的安装、配置和 Codex 生图说明，将完整 CLI 参考与开发发布流程迁移到独立文档。

## 0.2.0

### Minor Changes

- [`eab4dd7`](https://github.com/bingwu-devkit/imgrelay/commit/eab4dd7845098049520bfbcff0e1a4bc620ade56) Thanks [@BINGWU2003](https://github.com/BINGWU2003)! - 实现 ImgRelay 首版：供应商与凭据管理、模型发现、OpenAI Images 文生图、原图与记录保存、结构化输出，以及独立分发的 Codex Skill。
