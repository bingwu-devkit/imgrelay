# ImgRelay 多中转站兼容设计参考

- 日期：2026-10-10
- 状态：开发前设计参考；首版已按需求与开发计划实现，使用方式见 [README](../README.md)。本文保留原始分析与后续协议建议。
- 参考项目：[Z1rconium/gpt-image-panel](https://github.com/Z1rconium/gpt-image-panel)
- 阅读版本：本地 `v1.7.12`，提交 `69c3739eef2febe3c0c263ee594e1c58b48ad822`，工作区无修改。
- 分析依据：本地源码、配置模型和已有测试。未运行参考项目测试，未调用真实中转站。

## 1. 结论与首版边界

参考项目通过“供应商预设 + 分协议请求与响应处理 + 声明式映射”兼容不同中转站，
标准调用链没有按中转站品牌分别写一套客户端。

ImgRelay 可以采用同样的分层思路。首版先完成 `openai-images` 协议，让第二家同协议
供应商只需增加配置；之后根据真实接入需求增加 Responses、Chat Completions 或自定义
同步/异步适配器。首版不需要实现参考项目的全部协议、Web UI、队列或 Worker。

需要区分三种情况：

| 中转站情况                             | ImgRelay 的处理方式                                |
| -------------------------------------- | -------------------------------------------------- |
| 请求、响应符合已支持协议               | 新增供应商配置即可，无需改代码                     |
| 同协议，仅端点、默认参数或模型限制不同 | 使用端点覆盖、参数默认值和能力覆盖                 |
| 请求体、鉴权或任务流程超出已支持协议   | 增加适配器；后续可用有边界的声明式映射减少重复开发 |

支持多个中转站不等于支持所有自定义接口。超出协议能力时应明确报错，不能猜测请求格式，
也不能在失败后自动换端点、模型或供应商。

## 2. 参考项目如何实现兼容

下列源码链接固定到此次阅读的提交，便于后续复核。

### 2.1 用预设保存供应商差异

[`normalize_api_preset`](https://github.com/Z1rconium/gpt-image-panel/blob/69c3739eef2febe3c0c263ee594e1c58b48ad822/backend/app/core/api_paths.py#L86)
将供应商配置统一为预设，包含地址、凭据或引用、接口路径、默认模型、默认返回格式、
蒙版支持、`provider_kind` 和 `provider_config`。

[`presets.py`](https://github.com/Z1rconium/gpt-image-panel/blob/69c3739eef2febe3c0c263ee594e1c58b48ad822/backend/app/services/presets.py#L308)
管理多份预设及当前选中项，调用时解析实际凭据。标准 OpenAI 路径通过配置的地址和
Bearer 鉴权访问上游，自定义映射另外描述鉴权形态。

对 ImgRelay 的启示：供应商是配置实例，协议适配器可以被多家供应商共用。
CLI 隐藏输入密钥，配置使用 `apiKey` 明文保存。

### 2.2 集中处理地址拼接

[`build_upstream_url`](https://github.com/Z1rconium/gpt-image-panel/blob/69c3739eef2febe3c0c263ee594e1c58b48ad822/backend/app/core/api_paths.py#L44)
处理尾部斜杠、已经包含完整端点的地址，以及 Base URL 和端点重复包含 `/v1` 的情况。

例如，同一标准端点 `/v1/images/generations` 可以配合以下输入：

| Base URL                                      | 最终地址                                      |
| --------------------------------------------- | --------------------------------------------- |
| `https://relay.example`                       | `https://relay.example/v1/images/generations` |
| `https://relay.example/v1/`                   | `https://relay.example/v1/images/generations` |
| `https://relay.example/v1/images/generations` | 保留该完整端点，不重复拼接                    |

这是值得借鉴的兼容点，但其实现主要是字符串拼接。ImgRelay 应使用 URL 解析校验地址，
明确自定义前缀与端点覆盖的规则，避免直接用会丢弃基础路径的 `new URL('/path', base)`。

建议保存规范化的 API 基础地址；用户输入完整生成端点时，在配置阶段明确拆分或确认，
避免以后查询 `/models` 时把路径拼在生成端点后。默认标准端点采用 `/v1/...` 形式；
Base URL 已以 `/v1` 结尾时去掉端点重复的 `/v1`，其余基础路径按明确规则保留。
端点覆盖仅接受路径，带主机的覆盖不能悄悄改变凭据发送目标。

### 2.3 按协议构造请求、提取图片

[`call_image_generation_api`](https://github.com/Z1rconium/gpt-image-panel/blob/69c3739eef2febe3c0c263ee594e1c58b48ad822/backend/app/integrations/upstream/generation.py#L684)
选择调用分支，具体请求构造和图片提取集中在
[`payloads.py`](https://github.com/Z1rconium/gpt-image-panel/blob/69c3739eef2febe3c0c263ee594e1c58b48ad822/backend/app/integrations/upstream/payloads.py)。

| 分支             | 实际请求与响应处理                                                                                      |
| ---------------- | ------------------------------------------------------------------------------------------------------- |
| Images           | 请求图片参数，从 `data[]` 读取图片                                                                      |
| Responses        | 非流式发送 `{prompt, model}`；从 `output[]` 中的 `image_generation_call` 提取结果；流式另外设置图像工具 |
| Chat Completions | 发送 `messages`；从消息、SSE 内容、Markdown 图片或结构化字段提取 URL/Base64                             |
| 自定义映射       | 渲染配置中的请求，执行同步或异步流程，再通过配置路径提取图片                                            |

不同分支最后都归一到图片条目，再进入共同的下载、解码和保存流程。

**Responses 分支需要特别区分。** 参考项目的非流式 `{prompt, model}` 请求反映了它的
网关约定，不能直接视为标准 OpenAI Responses 图像工具请求。ImgRelay 后续实现该协议时，
应根据实际接口文档确定 `input`、`tools`、主模型与图像工具参数；有差异的中转站使用明确的
变体配置或独立适配器，不能只改 URL 就复用 Images 的请求体。

Chat Completions 分支也不能照搬 Images 参数。若适配器无法表达尺寸、数量等显式要求，
应说明不支持，不能默默丢弃参数后仍声称已经按要求生成。

### 2.4 用声明式映射兼容非标准接口

[`provider_mapping.py`](https://github.com/Z1rconium/gpt-image-panel/blob/69c3739eef2febe3c0c263ee594e1c58b48ad822/backend/app/core/provider_mapping.py)
提供固定变量的 JSON 模板和有限 JSONPath：`$.a.b[0]`、`[*]`。配置不会作为代码执行。
整个值是变量时保留数字、数组等类型；缺少可选变量时省略字段，而不是发送空字符串。

[`ProviderConfigV2`](https://github.com/Z1rconium/gpt-image-panel/blob/69c3739eef2febe3c0c263ee594e1c58b48ad822/backend/app/schemas/provider/v2.py#L318)
描述鉴权、提交、轮询、结果、取消和编辑请求，支持两类流程：

- 同步：提交响应直接含图片，省略轮询和取消配置。
- 异步：提交返回后续 URL 或任务 ID，轮询状态后获取图片。

其 `provider_kind` 仍叫 `async_json`，但 v2 已经支持同步模式。ImgRelay 如果后续采用这种
设计，建议用 `mapped-json` 之类能同时表达两种模式的协议名，并单独保存映射 schema 版本。

这类映射能处理字段名和任务状态差异，但不能覆盖任意签名算法、二进制协议或复杂业务步骤。
这些情况仍应由专门适配器处理。没有具体非标准供应商接入需求时，不需要先做完整映射引擎。

### 2.5 统一能力视图与异步恢复

[`ProviderCapabilities`](https://github.com/Z1rconium/gpt-image-panel/blob/69c3739eef2febe3c0c263ee594e1c58b48ad822/backend/app/schemas/provider/resolved.py#L58)
统一生成、编辑、蒙版、流式、透明背景和格式能力，让界面与任务准入消费同一份结果。
其中部分能力由映射结构推导，例如是否存在编辑段、是否能携带蒙版。

[`run_async_provider`](https://github.com/Z1rconium/gpt-image-panel/blob/69c3739eef2febe3c0c263ee594e1c58b48ad822/backend/app/integrations/upstream/async_provider.py#L948)
支持远端任务检查点，保存任务 ID、后续地址、截止时间、幂等键及非敏感配置快照。
已经提交的任务恢复时继续轮询；提交结果未知且没有幂等条件时，不自动重新提交。

需要保留一个区别：映射能传递 `background`，只证明请求能表达这个参数，不能证明上游支持
透明背景。ImgRelay 的模型能力应区分“支持、明确不支持、未知”，并记录依据。

## 3. 适合 ImgRelay 的模块边界

建议在现有 TypeScript workspace 中分离核心逻辑和 CLI；这是目录建议，不是已确定的发布形态。

```text
packages/core/src/
  config/          # 用户配置、版本迁移、供应商管理
  credentials/     # 配置中的 API Key
  models/          # 模型发现、隔离缓存、模型能力
  providers/       # 协议适配器与端点解析
    openai-images/
  transport/       # HTTP、超时、取消、脱敏和重试策略
  images/          # Base64、URL、格式尺寸识别和原图保存
  records/         # 请求与结果记录
packages/cli/src/  # 参数解析、人类输出、JSON 和退出码
skills/imgrelay/   # Codex 使用说明
```

一次生成的核心调用链应为：

```text
解析命令 → 读取供应商 → 合并参数 → 校验能力 → 解析凭据
        → 适配器构造请求 → 提交一次 → 解析图片条目
        → 逐项保存原图 → 保存记录 → 输出最终 JSON
```

协议适配器负责构造请求与解释协议结果，不负责命令行输出、用户凭据存储或最终文件命名。
非标准异步适配器还负责执行任务流程，向外返回图片结果和必要的任务状态。
模型列表查询是可选的只读能力，不应成为生成命令的必经步骤。

### 3.1 供应商配置建议

以下仅为待实现的配置示例，字段名尚未定稿：

```json
{
  "schemaVersion": 1,
  "defaultProvider": "cubence",
  "providers": {
    "cubence": {
      "protocol": "openai-images",
      "baseUrl": "https://api-lb.cubence.ai/v1",
      "apiKey": "your-cubence-api-key",
      "defaultModel": "gpt-image-2.5-flare",
      "defaults": {
        "size": "auto",
        "n": 1,
        "quality": "high",
        "outputFormat": "png"
      },
      "timeoutSeconds": 600
    },
    "another-relay": {
      "protocol": "openai-images",
      "baseUrl": "https://relay.example/v1",
      "apiKey": "your-relay-api-key",
      "defaultModel": "vendor-image-model"
    }
  }
}
```

供应商可另外保存端点覆盖和按模型的能力覆盖。配置与明文 API Key 保存到 `~/.imgrelay/config.json`，
模型缓存保存在同目录；文件使用系统默认权限。首版 Images 默认使用
Bearer 鉴权，其他鉴权形态应作为后续适配器明确支持的能力。

全局 `schemaVersion` 与后续映射配置的版本分别管理。未知协议或无效配置应报错，
不要像参考项目部分规范化函数那样静默回退到默认协议或路径。

### 3.2 参数、能力与模型缓存

- 参数值：命令显式值 → 供应商默认值 → 工具默认值；未知模型仍可调用。
- 参数限制：供应商按模型覆盖 → 已知模型能力 → 未知时交上游验证；显式参数也必须校验。
- 请求只发送需要的字段。无依据的可选字段保持省略，GPT Image 不默认发送 `response_format`。
- 能力记录来源与验证时间；一次调用成功只证明该次组合成功，不推广成全部参数已验证。
- 模型缓存按供应商、模型端点、配置修订和实际凭据的 SHA-256 摘要隔离；修改地址或密钥时失效。
- 配置文件中的实际密钥参与缓存索引摘要计算；无需独立 HMAC 秘密键，
  不能把实际密钥明文写进缓存。
- 手动模型无需在缓存列表中存在；只读查询失败不能自动阻止已明确指定模型的生成请求。

工具默认值应尽量少，例如数量 1、默认输出目录；`high`、`png`、`auto` 的组合可以作为
Cubence 已有验证记录对应的供应商预设，不能无条件应用到所有第三方模型。

### 3.3 图片与失败结果

借鉴参考项目
[`extract_image_bytes`](https://github.com/Z1rconium/gpt-image-panel/blob/69c3739eef2febe3c0c263ee594e1c58b48ad822/backend/app/integrations/upstream/transport.py#L294)
和保存流程：Base64 优先、URL 下载不携带 API Key、限制响应大小、从图片字节识别格式和尺寸。

ImgRelay 还需要保证：

- 每个图片条目独立校验、解码和保存；一项失败后继续处理其余结果。
- 返回已保存文件与逐项错误，按全部成功、部分成功或全部失败输出稳定状态和退出码。
- 保存原始字节，以实际格式命名；请求尺寸和实际尺寸分别记录。
- 日志、JSON 和记录不含鉴权头、Base64 或带访问凭据的原始下载链接。
- 生成结果已返回但下载或保存失败时，不能把整个操作重新提交为一次新的生成。

参考项目共用保存函数会在某项异常时抛出错误，不能直接当作 ImgRelay 的逐项部分成功实现。

## 4. 不应直接照搬的行为

| 参考项目的行为                                    | ImgRelay 应如何调整                                                                   |
| ------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 默认模型为 `gpt-image-2`，默认返回格式为 `url`    | 默认模型来自用户配置；无默认模型时报配置错误，GPT Image 不默认发送 `response_format`  |
| 全局尺寸校验带边长、像素数、16 倍数和比例限制     | 基础语法校验与模型限制分开；供应商覆盖优先，未知能力不套用另一模型的限制              |
| 对枚举的 2.5 模型设置特定质量、端点和返回格式行为 | 可作为有来源的能力记录参考，不能凭名称声称所有站点行为相同                            |
| 部分情况下把 JPEG 改成 PNG、调整压缩参数          | 显式要求不适用时返回明确错误，不悄悄更改参数                                          |
| 队列将多图请求拆成多个 `n=1` 单元                 | 首版按用户数量提交一个请求，不能自动拆成多次付费生成                                  |
| 支持提示词前缀、色键背景去除和编辑结果贴回        | CLI 原样发送提示词、保存原图；这些不是本项目首版职责                                  |
| 非流式 Responses 使用 `{prompt, model}`           | 作为特定网关的实现证据；标准协议需另行核对契约                                        |
| 端点探测收到 401/403 时也归为可达                 | `doctor` 分别报告地址可达、鉴权状态、模型发现状态和生成未验证；不能把可达当作鉴权成功 |
| 自托管服务的队列、租约、数据库和 Worker 恢复      | 首版 CLI 不引入；异步协议确有需要时再增加任务检查点                                   |

多图拆分的源码在
[`image_jobs.py`](https://github.com/Z1rconium/gpt-image-panel/blob/69c3739eef2febe3c0c263ee594e1c58b48ad822/backend/app/repositories/image_jobs.py#L299)，
参数转换在
[`validate_output_options`](https://github.com/Z1rconium/gpt-image-panel/blob/69c3739eef2febe3c0c263ee594e1c58b48ad822/backend/app/schemas/generation.py#L77)。
端点探测的状态分类在
[`classify_probe_status`](https://github.com/Z1rconium/gpt-image-panel/blob/69c3739eef2febe3c0c263ee594e1c58b48ad822/backend/app/integrations/upstream/transport.py#L326)。
只读检查不能证明生成或所有参数可用，也不能在模型列表不可用时自动付费生图来验证。

异步支持进入后续版本时，优先复用“提交结果未知不重提、已知任务恢复轮询、固定截止时间、
非敏感配置快照”的原则。首版生成请求仍不自动重试；供应商提供幂等头也不能仅凭字段名
断定它有可靠幂等保证。状态/结果/取消请求需要凭据时，应校验同源并禁止自动跨域重定向。

## 5. 开发与兼容性验证顺序

1. 配置、凭据和供应商命令；规范化端点并让 `doctor` 展示最终地址；实现模型发现和缓存。
2. 实现 Images 非流式适配器、逐项原图保存、生成记录、JSON 和稳定错误分类。
3. 编写 Skill，用两家配置驱动的本地模拟中转站验证共同适配器，随后完成用户授权的
   Cubence 实际调用验证。
4. 接入明确需要的图片编辑或其他协议；非标准站点出现重复需求时再实现声明式映射。

兼容性测试应验证对外行为，至少覆盖：

| 测试场景                                        | 主要验证点                                                    |
| ----------------------------------------------- | ------------------------------------------------------------- |
| 两家同协议站点切换                              | 地址、鉴权、默认模型、缓存互相隔离，不新增品牌分支            |
| 主机地址、`/v1`、尾斜杠、定制前缀和完整端点输入 | 最终生成与模型查询地址符合配置规则，无重复或丢失路径          |
| 未知模型、缺少 `/models`、手动模型              | 不因本机枚举或列表缺失而禁止明确的生成                        |
| 能力覆盖与单次命令参数                          | 显式参数仍受覆盖约束，合法覆盖不修改持久默认值                |
| Base64、URL、两者并存、多图混合失败             | Base64 优先，跨域图片下载无 Key，全部成功项保留并报告部分成功 |
| 请求 PNG 却返回 JPEG、请求尺寸与实际不同        | 原图字节不变，实际格式和尺寸准确                              |
| 超时、断网、鉴权失败、参数拒绝、保存失败        | 生成提交次数最多一次，不自动换模型或供应商                    |
| 上游错误回显 Key、带签名 URL、JSON 模式         | 脱敏且标准输出仅一个最终 JSON                                 |

参考项目已有针对地址拼接、映射版本、同步结果、异步恢复和凭据边界的测试，可借鉴场景：

- [地址拼接](https://github.com/Z1rconium/gpt-image-panel/blob/69c3739eef2febe3c0c263ee594e1c58b48ad822/backend/tests/test_access_settings_contract.py#L960)
- [自定义协议与能力](https://github.com/Z1rconium/gpt-image-panel/blob/69c3739eef2febe3c0c263ee594e1c58b48ad822/backend/tests/test_custom_provider_protocol_contract.py)
- [任务 ID 映射与版本兼容](https://github.com/Z1rconium/gpt-image-panel/blob/69c3739eef2febe3c0c263ee594e1c58b48ad822/backend/tests/test_provider_mapping_v2_contract.py)
- [异步恢复与未知提交](https://github.com/Z1rconium/gpt-image-panel/blob/69c3739eef2febe3c0c263ee594e1c58b48ad822/backend/tests/test_async_provider_recovery_contract.py)

这些是本次阅读到的测试依据，不代表已经运行通过，也不代表这些中转站已经在 ImgRelay
实际接入。具体发布形态、平台支持和安装方式仍按需求文档中的待定事项决定。
