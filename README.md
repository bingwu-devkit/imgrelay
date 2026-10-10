# ImgRelay

通过统一 CLI 和 Codex Skill 调用多家 OpenAI Images 兼容中转站。用户级配置跨项目复用，
生成结果默认保存在当前工作目录的 `output/imagegen/`。

首版支持文生图、供应商与凭据管理、模型列表缓存、只读检查、原图保存和 JSON 输出。
图片编辑、Responses、Chat Completions 与非标准异步协议属于后续范围。

## 安装与开发

需要 Node.js 22.20+（22.x）或 24.x。发布到 npm 后：

```bash
npm install -g imgrelay
npx skills add bingwu-devkit/imgrelay --skill imgrelay --agent codex --global --copy
```

CLI 与 Skill 分开安装；npm 安装不会改动 Codex 配置。当前源码可直接构建运行：

```bash
pnpm install
pnpm build
node packages/cli/dist/index.mjs --help
npx skills add ./skills --skill imgrelay --agent codex --global --copy
```

开发使用 pnpm 11.15.1。以下示例中的 `imgrelay` 可替换为上述 Node 命令。

## 首次配置

交互式配置直接隐藏输入密钥并保存到 `config.json`，随后查询模型列表并设置默认项。
查询失败时可手动填入模型 ID，配置流程不生成图片：

```bash
imgrelay provider add cubence --preset cubence
imgrelay provider use cubence
imgrelay doctor --provider cubence
```

修改密钥同样使用交互式隐藏输入，留空保留当前密钥：

```bash
imgrelay provider edit cubence
```

新增供应商和输入新密钥须在交互终端中运行，不加 `--json`。密钥明文保存在配置中，
不要求以 `sk-` 开头；删除供应商会一并移除其密钥。
非交互命令可修改已有供应商的其他参数或显式清除密钥：

```bash
imgrelay provider edit cubence --model vendor-model --json
imgrelay provider edit cubence --clear-key --json
```

## 命令

| 命令                                   | 用途                                      |
| -------------------------------------- | ----------------------------------------- |
| `provider add <名称>`                  | 添加供应商；可显式选择 `--preset cubence` |
| `provider list`                        | 列出摘要及默认项                          |
| `provider show <名称>`                 | 查看脱敏配置                              |
| `provider edit <名称>`                 | 修改配置与凭据，`--clear-key` 清除凭据    |
| `provider use <名称>`                  | 设置默认供应商                            |
| `provider remove <名称>`               | 移除供应商及配置中保存的密钥              |
| `models [--provider 名称] [--refresh]` | 查询模型或查看 15 分钟缓存                |
| `doctor [--provider 名称]`             | 检查配置、鉴权和模型查询，不生成图片      |
| `generate`                             | 生成并保存图片及记录                      |

所有命令支持 `--json` 和 `--help`，根命令支持 `--version`。
JSON 模式禁用交互，标准输出仅包含一个最终 JSON，进度在标准错误。

## 生成图片

```bash
imgrelay generate --prompt "一只戴宇航员头盔的猫"
imgrelay generate --prompt "一只戴宇航员头盔的猫" --provider cubence --n 2 --json
imgrelay generate --prompt "一只戴宇航员头盔的猫" --model vendor-model --size auto --quality high --output-format png
imgrelay generate --prompt "一只戴宇航员头盔的猫" --output-dir ./images --filename cat.png --timeout 600
```

生成时必须通过 `--prompt` 提供非空文本。CLI 原样发送内容，保留换行及首尾空白，
不自动添加风格或约束。长提示词也通过此选项传递，按当前 shell 正确引用以保留特殊字符。

单次参数覆盖不会改动持久配置。参数值按“命令 → 供应商默认 → 工具默认”合并；
工具仅默认数量为 1，不强制尺寸、质量或格式。未知模型允许调用，模型列表缺失不阻断生成。

图片保留原始字节；Base64 优先于 URL，图片下载及重定向不带 API Key。
记录实际格式、尺寸和字节数。默认文件名包含 UUID 和序号；自定义文件名的扩展名按实际格式，
多图追加序号。默认不覆盖文件，显式 `--overwrite` 才允许覆盖。

默认生成超时为 600 秒；只读请求最多重试一次，生成 POST 不自动重试。
超时或断网意味着结果未知，上游可能仍在生成。不会自动换模型、降参数或拆成多次付费请求。
每张图片最多 32 MiB，上游 JSON 最多 128 MiB；某项失败后继续保存其他结果。

## 中转站兼容配置

同协议中转站通过 `provider add` 接入，不新增品牌客户端。
Base URL 支持主机地址、`/v1`、自定义前缀及标准完整生成 URL，并集中处理路径拼接。
`doctor` 展示最终地址；认证模型接口成功只证明模型查询可用，不证明生成及全部参数可用。

`provider add/edit` 还支持 `--generation-path`、`--models-path`、默认生成参数、
`--timeout` 和 `--capabilities-file`。端点覆盖仅接受路径，不能更换主机。
能力覆盖文件是按模型 ID 索引的 JSON：

```json
{
  "vendor-model": {
    "source": "provider_override",
    "parameters": {
      "n": { "min": 1, "max": 1 },
      "quality": { "values": ["high"] },
      "outputFormat": { "values": ["png", "webp"] },
      "responseFormat": { "supported": false }
    }
  }
}
```

校验按“供应商覆盖 → 已知模型能力 → 上游验证”执行，显式命令参数同样受覆盖约束。
内置 GPT Image 1/mini 的已知参数；供应商可覆盖具体差异。Cubence 预设来自需求中的一次
成功调用，仅提供默认组合，不推断其全部能力。GPT Image 默认不发送 `response_format`；
确需配置兼容返回格式的站点可通过供应商默认值与能力覆盖明确表达。

## 配置与输出

Windows、Linux 和 macOS 的配置目录统一为当前用户主目录下的 `~/.imgrelay/`。
`IMGRELAY_CONFIG_DIR` 可覆盖目录，相对路径基于当前工作目录解析。

供应商配置与明文 API Key 集中保存在版本 1 的 `config.json`，模型缓存保存在同目录的
`models-cache.json`。文件使用系统默认权限，不做加密、专用 ACL 或权限校验。
隐藏输入的密钥保存在供应商的 `apiKey` 字段。配置结构例如：

```json
{
  "schemaVersion": 1,
  "defaultProvider": "relay",
  "providers": {
    "relay": {
      "protocol": "openai-images",
      "baseUrl": "https://relay.example/v1",
      "apiKey": "your-api-key",
      "defaultModel": "vendor-model"
    }
  }
}
```

模型缓存索引为供应商、配置修订、端点和实际凭据的 SHA-256 摘要，地址或实际凭据变化后
不会复用旧查询。CLI 输出、日志、JSON 和生成记录保持脱敏，不保存密钥明文、鉴权头、
原始 Base64 或带访问凭据的下载链接。图片和生成记录默认保存在当前工作目录的
`output/imagegen/`，可通过 `--output-dir` 指定。
生成记录含提示词及请求参数，应按本机文件管理方式处理。

JSON 外层固定为 `schemaVersion`、`command`、`status`、`data`、`error`。
生成结果的 `data.images` 包含本地路径、实际格式/尺寸/字节数，另有请求模型、上游报告模型
（仅在返回时）、失败项、用量和 `recordPath`。使用 `error.category` 判断失败类型。
请求提交前保存记录，单项保存失败保留其他图片，记录保存失败仍返回已保存路径。
`data.endpoint` 是本次实际生成地址，`data.capabilityEvidence` 保留已知模型与供应商覆盖的
来源及已有验证时间；未知能力显示为空，不从一次成功调用推断其他能力。

| 退出码 | 含义                                 |
| ------ | ------------------------------------ |
| 0      | 成功                                 |
| 1      | 内部错误                             |
| 2      | 输入、配置、凭据或本地能力校验错误   |
| 3      | 上游错误、无效图片响应或生成结果未知 |
| 4      | 图片或记录保存失败                   |
| 5      | 部分图片成功                         |
| 130    | 用户中断；不能保证取消上游请求       |

## 验证与发布

```bash
pnpm check
node scripts/package-smoke.mjs
```

测试使用本地模拟中转站和真实 CLI 子进程，不消耗真实 API 额度。
CI 覆盖 Windows、Linux、macOS 和 Node.js 22、24，包括凭据权限及独立打包安装检查。
Skill 使用 skill-creator 校验器检查；Skills CLI 可用 `npx skills add ./skills --list` 验证发现。

真实 Cubence 单张生成作为发布前人工验收，在用户明确要求并提供凭据来源后执行。
自动发布使用 npm Trusted Publishing，需在 npm 配置对应仓库和 `release.yml`，并允许 GitHub Actions 创建 PR。
提交 changeset 到 `main` 后会创建或更新版本 PR；合并版本 PR 后自动发布 npm 包和 GitHub Release。

需求及设计依据见
[需求文档](https://github.com/bingwu-devkit/imgrelay/blob/main/docs/image-relay-requirements.md)、
[兼容性参考](https://github.com/bingwu-devkit/imgrelay/blob/main/docs/provider-compatibility-design.md)。

## 许可证

[MIT](./LICENSE.md)。保留模板原有版权归属。
