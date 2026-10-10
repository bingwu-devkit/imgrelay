# ImgRelay CLI 参考

首次安装与 Codex 使用方式见 [README](../README.md)。本页说明当前 CLI 的命令、配置和输出约定。

## 命令与交互

| 命令                                   | 用途                                      |
| -------------------------------------- | ----------------------------------------- |
| `provider add <名称>`                  | 交互添加供应商，可选择 `--preset cubence` |
| `provider list`                        | 列出脱敏摘要及默认项                      |
| `provider show <名称>`                 | 查看脱敏配置                              |
| `provider edit <名称>`                 | 修改配置与凭据，`--clear-key` 清除密钥    |
| `provider use <名称>`                  | 设置默认供应商                            |
| `provider remove <名称>`               | 移除供应商及其密钥                        |
| `models [--provider 名称] [--refresh]` | 查询模型，默认允许使用 15 分钟缓存        |
| `doctor [--provider 名称]`             | 检查配置、鉴权与模型接口，不生成图片      |
| `generate --prompt <文本>`             | 生成并保存原图和记录                      |

以上命令均以 `imgrelay` 开头，支持 `--help` 和 `--json`；根命令支持 `--version`。
JSON 模式禁用交互，标准输出只有一个最终 JSON，进度在标准错误。

新增供应商必须在交互终端中运行，不加 `--json`。API Key 通过隐藏输入获取，完成模型选择、
默认参数和默认供应商设置后统一保存；中途取消不会保存修改。
模型查询失败时可以手动填写 ID，整个配置流程不生成图片。

更新密钥也使用交互模式，留空保留当前密钥；密钥不要求以 `sk-` 开头。
非交互模式可修改已有供应商的其他参数，或显式清除密钥：

```bash
imgrelay provider edit relay
imgrelay provider edit relay --model vendor-model --json
imgrelay provider edit relay --clear-key --json
```

### 供应商配置选项

`provider add/edit` 共用以下选项。生成参数在这里设置后成为供应商默认值。

| 选项                                               | 用途                                      |
| -------------------------------------------------- | ----------------------------------------- |
| `--base-url <URL>`                                 | API 基础地址，推荐包含 `/v1`              |
| `--protocol <协议>`                                | 当前支持 `openai-images`                  |
| `--preset <名称>`                                  | 当前提供 `cubence` 预设                   |
| `--model <ID>`                                     | 默认模型，允许手动填写                    |
| `--default`                                        | 保存后设为默认供应商                      |
| `--clear-key`                                      | 清除配置中保存的密钥                      |
| `--size`、`--n`、`--quality`、`--output-format`    | 默认生成参数，各选项需要对应值            |
| `--response-format <格式>`                         | 供应商要求的返回格式：`url` 或 `b64_json` |
| `--generation-path <路径>`、`--models-path <路径>` | 覆盖生成或模型查询端点                    |
| `--capabilities-file <文件>`                       | 按模型 ID 索引的能力覆盖 JSON             |
| `--timeout <秒数>`                                 | 默认生成等待超时，初始为 600 秒           |

Cubence 预设提供地址 `https://api-lb.cubence.ai/v1`、模型 `gpt-image-2.5-flare`，以及
`size=auto`、`n=1`、`quality=high`、`outputFormat=png`。预设只提供这组默认配置，
不代表供应商的全部模型或参数都经过验证；交互流程允许调整默认模型和参数。

## 生成选项

```bash
imgrelay generate --prompt "一只戴宇航员头盔的猫" --json
imgrelay generate --provider relay --model vendor-model --prompt "一只戴宇航员头盔的猫" --n 2 --json
imgrelay generate --prompt "一只戴宇航员头盔的猫" --size auto --quality high --output-format png
imgrelay generate --prompt "一只戴宇航员头盔的猫" --output-dir ./images --filename cat.png --timeout 600
```

| 选项                                         | 用途                                              |
| -------------------------------------------- | ------------------------------------------------- |
| `--prompt <文本>`                            | 必填、非空提示词；CLI 原样发送内容                |
| `--provider <名称>`、`--model <ID>`          | 本次使用的供应商和模型                            |
| `--size <尺寸>`                              | 如 `auto` 或 `1024x1024`，可用值取决于模型能力    |
| `--n <数量>`                                 | 正整数，不自动拆成多次请求                        |
| `--quality <质量>`、`--output-format <格式>` | 请求质量与图片格式                                |
| `--output-dir <目录>`                        | 保存目录，默认当前工作目录下的 `output/imagegen/` |
| `--filename <名称>`                          | 普通文件名；目录用 `--output-dir` 指定            |
| `--overwrite`                                | 允许覆盖图片文件，默认不覆盖                      |
| `--timeout <秒数>`                           | 覆盖本次生成等待超时                              |

提示词仅通过 `--prompt` 传递，没有文件或 stdin 入口。CLI 保留换行与首尾空白，
不添加风格或约束；长提示词也使用此选项，按当前 shell 正确引用特殊字符。

参数按“本次命令 → 供应商默认 → 工具默认”合并，不修改持久配置。
工具默认数量为 1，不强制尺寸、质量或格式。未知模型允许调用，模型列表缺失不阻断生成。
`generate` 不提供 `--response-format`，需要该字段的供应商通过默认配置设置。

### 保存与等待

图片保留原始字节，Base64 优先于 URL；下载图片及跟随重定向时不带 API Key。
记录实际格式、尺寸和字节数，每张图片最多 32 MiB，上游 JSON 最多 128 MiB。
某项解码、下载或保存失败后，仍继续处理其他图片。

默认文件名包含 UUID 和序号。自定义文件名的扩展名按实际图片格式确定，多图追加序号。
生成记录文件名为 `<UUID>-report.json`，不受 `--filename` 影响。

默认生成等待超时为 600 秒，可由供应商配置或本次参数覆盖。只读 API 请求最多重试一次，
生成 POST 不自动重试。超时或断网意味着结果未知，上游可能仍在生成；不会自动换模型、
降参数、拆单或补齐少返回的图片。执行工具报告进程仍在运行时，应继续等待同一个进程。

## 中转站兼容配置

同为 OpenAI Images 兼容协议的中转站通过新增供应商配置接入。
当前不支持图片编辑、Responses、Chat Completions 或非标准异步任务协议。

Base URL 支持主机地址、`/v1`、自定义前缀及标准完整生成 URL，工具集中处理路径拼接。
默认端点为 `/v1/images/generations` 和 `/v1/models`。端点覆盖仅接受路径，不能更换主机。
`doctor` 展示最终地址；模型接口鉴权成功只证明模型查询可用，不证明生成及全部参数可用。

### 模型能力覆盖

能力覆盖文件按模型 ID 索引，例如：

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

```bash
imgrelay provider edit relay --capabilities-file ./capabilities.json --json
```

可覆盖的参数为 `size`、`n`、`quality`、`outputFormat`、`responseFormat`。
每项可声明 `supported`、`values`、`min` 和 `max`；来源可附带 `sourceUrl` 和 `verifiedAt`。
JSON 中使用驼峰字段，CLI 选项使用连字符。

工具内置 `gpt-image-1` 和 `gpt-image-1-mini` 的已知参数能力。供应商覆盖按参数替换对应的
已知限制，未覆盖的参数仍沿用已知能力；未知能力交由上游验证。显式命令参数同样受能力约束。
GPT Image 默认不发送 `response_format`；确有需要时通过供应商默认值和能力覆盖表达。
不会从一次成功调用推断其他模型或参数的能力。

## 配置存储

Windows、Linux 和 macOS 统一使用当前用户主目录下的 `~/.imgrelay/`。
`IMGRELAY_CONFIG_DIR` 可覆盖目录，相对路径基于当前工作目录解析。

`config.json` 集中保存供应商配置与明文 API Key，版本为 1。例如：

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

密钥保存在供应商的 `apiKey` 字段，删除供应商会一并删除密钥。
配置文件使用系统默认权限，不做加密、专用 ACL 或权限校验。

模型缓存保存在同目录的 `models-cache.json`。缓存索引由供应商名称、配置修订、端点和实际凭据
的 SHA-256 摘要构成；地址或凭据变化后不会复用旧查询。

CLI 输出、日志、JSON 和生成记录脱敏，不保存密钥明文、鉴权头、原始 Base64 或带访问凭据的
下载链接。生成记录含提示词及请求参数；图片和记录默认保存在当前项目的 `output/imagegen/`。

## JSON 结果与退出码

JSON 外层固定为 `schemaVersion`、`command`、`status`、`data`、`error`。
`schemaVersion` 当前为 1。生成的 `status` 为：

| 状态              | 含义                                                            |
| ----------------- | --------------------------------------------------------------- |
| `success`         | 已返回的图片条目均成功保存；实际数量未必等于请求数量            |
| `partial_success` | 部分图片成功保存，失败详情在 `data.failures`，顶层 `error` 为空 |
| `error`           | 发生错误，仍可能有已保存图片                                    |
| `unknown`         | 请求结果未知，上游可能仍在生成                                  |
| `interrupted`     | 用户中断，不能保证取消已提交的上游请求                          |

读取结果时先检查 `data`，再读取 `images`。生成前的输入、配置、凭据或初始记录创建错误可能
返回 `data: null`。任何状态都不能只凭退出码判断是否存在已保存图片。

| 生成结果字段                                | 内容                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------- |
| `data.images`                               | 已保存图片的 `index`、`path`、实际 `format`、`width`、`height`、`bytes`     |
| `data.provider`、`data.requestedModel`      | 本次供应商和请求模型                                                        |
| `data.reportedModel`                        | 上游报告的模型，仅返回该字段时存在，不证明底层模型身份                      |
| `data.requestedCount`、`data.returnedCount` | 请求数量和上游返回条目数，成功保存数量为 `images.length`                    |
| `data.failures`                             | 单项失败的 `index` 和 `error`                                               |
| `data.recordPath`                           | 本地生成记录路径，最终记录更新失败时为 `null`                               |
| `data.parameters`、`data.endpoint`          | 请求参数和实际生成地址                                                      |
| `data.capabilityEvidence`                   | 已知模型与供应商覆盖的来源及已有验证时间，未知项为 `null`                   |
| `data.submissionStatus`                     | `not_submitted`、`submitted`、`result_received` 或 `unknown`                |
| `data.usage`                                | 上游返回的数值用量及嵌套数值字段，仅有可用数据时存在                        |
| `error`                                     | 顶层错误的 `category`、`message` 和可选 `httpStatus`，无顶层错误时为 `null` |

使用顶层 `error.category` 和 `data.failures[].error.category` 判断失败类型。
本地能力错误与上游参数错误都可能是 `parameter_unsupported`，需结合退出码和提交状态判断。
超时或断网对应 `result_unknown` 与 `submissionStatus: unknown`。

请求提交前先创建记录，创建失败会阻止生成 POST。单项保存失败保留其他图片；
最后更新记录失败时仍返回已保存路径，`recordPath` 为空，不能通过重新生图恢复保存。

| 退出码 | 含义                                 |
| ------ | ------------------------------------ |
| 0      | 成功                                 |
| 1      | 内部错误                             |
| 2      | 输入、配置、凭据或本地能力校验错误   |
| 3      | 上游错误、无效图片响应或生成结果未知 |
| 4      | 图片或记录保存失败                   |
| 5      | 部分图片成功                         |
| 130    | 用户中断                             |
