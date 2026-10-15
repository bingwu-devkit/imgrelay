# ImgRelay CLI 参考

首次安装与 Codex 使用方式见 [README](../README.md)。本页按使用场景介绍 CLI 命令。
示例中的 `relay` 是供应商名称，`vendor-model` 请替换为供应商提供的模型 ID。

## 配置与管理供应商

### 添加供应商

在终端运行下面的命令，按提示填写 API 地址、密钥、默认模型和生成参数：

```bash
imgrelay provider add relay --default
```

密钥通过隐藏输入填写。模型查询失败时，可直接输入供应商提供的模型 ID。
使用 Cubence 时，可选择预设：

```bash
imgrelay provider add cubence --preset cubence --default
```

### 查看和切换供应商

```bash
imgrelay provider list
imgrelay provider show relay
imgrelay provider use relay
```

`list` 查看已配置的供应商和默认项，`show` 查看某个供应商的配置，`use` 设置默认供应商。
生成时也可通过 `--provider` 临时选择其他供应商。

### 修改密钥、模型和默认参数

更新地址或密钥时运行交互编辑：

```bash
imgrelay provider edit relay
```

只修改模型或默认生成参数，也可直接指定选项：

```bash
imgrelay provider edit relay --model vendor-model --json
imgrelay provider edit relay --size auto --n 1 --quality high --output-format png --json
```

更改前确认模型支持对应参数。需要清除密钥或删除供应商时，分别运行：

```bash
imgrelay provider edit relay --clear-key --json
imgrelay provider remove relay
```

### 查询模型和检查连接

```bash
imgrelay models --provider relay
imgrelay models --provider relay --refresh
imgrelay doctor --provider relay
```

`models` 查询模型列表，`--refresh` 获取最新列表；`doctor` 检查配置和模型接口连接。
如果供应商没有提供模型查询接口，可直接在生成时用 `--model` 指定模型。

## 生成图片

### 准备提示词文件

新建 `prompt.txt`，写入主题、构图和其他要求，例如：

```text
一只戴宇航员头盔的猫，蓝色背景。
完整角色，横向构图，适合作为博客封面。
```

在文件所在目录运行：

```bash
imgrelay generate --prompt-file ./prompt.txt
```

### 选择模型和生成多张图片

```bash
imgrelay generate --prompt-file ./prompt.txt --provider relay --model vendor-model --n 2
```

未指定的设置使用当前默认配置。`--n` 指定本次请求的图片数量，可用数量取决于模型和供应商。

### 设置尺寸、质量和格式

```bash
imgrelay generate --prompt-file ./prompt.txt --size auto --quality high --output-format png
```

按模型支持的值填写。例如，`gpt-image-1` 可使用 `1024x1024`、`1536x1024`、`1024x1536` 等尺寸。

### 指定保存目录和文件名

```bash
imgrelay generate --prompt-file ./prompt.txt --output-dir ./images --filename cat.png
```

默认保存到当前目录下的 `output/imagegen/`。多张图片会在文件名后追加序号；
扩展名按实际返回的图片格式确定。需要覆盖已有图片时，加上 `--overwrite`。

### 从管道读取提示词

在 Bash 中，可把文件或其他程序输出的提示词传给 CLI：

```bash
cat ./prompt.txt | imgrelay generate --prompt-stdin
```

Windows PowerShell 可直接使用前面的 `--prompt-file` 示例。

### 预览生成配置（可选）

想先查看本次使用的供应商、模型、生成参数和保存位置时，运行：

```bash
imgrelay generate --prompt-file ./prompt.txt --output-dir ./images --filename cat.png --dry-run --json
```

`--dry-run` 只进行本地检查，不发起生图，也不消耗生图额度。
确认配置后，执行对应的生成命令即可；供应商是否接受请求，以实际生成结果为准。

### 生成选项速查

| 选项                     | 用途                          |
| ------------------------ | ----------------------------- |
| `--prompt-file <路径>`   | 从提示词文件生成              |
| `--prompt-stdin`         | 从管道读取提示词              |
| `--provider <名称>`      | 选择本次供应商                |
| `--model <ID>`           | 选择本次模型                  |
| `--size <尺寸>`          | 设置图片尺寸                  |
| `--n <数量>`             | 设置请求图片数量              |
| `--quality <质量>`       | 设置生成质量                  |
| `--output-format <格式>` | 设置请求图片格式              |
| `--output-dir <目录>`    | 设置保存目录                  |
| `--filename <名称>`      | 设置图片文件名                |
| `--overwrite`            | 覆盖已有图片                  |
| `--timeout <秒数>`       | 设置生成等待时间，默认 600 秒 |
| `--dry-run`              | 预览本次生成配置              |
| `--json`                 | 输出适合脚本读取的结果        |

## 查看生成结果

生成完成后，查看命令输出中的图片路径。保存目录中同时包含原图和
`<请求 ID>-report.json` 生成记录，方便查阅模型、参数和请求结果。

生成默认等待 10 分钟。需要更长时间时，可在命令后加 `--timeout 1200`，等待最多 20 分钟。
如果正在等待结果，继续等待同一个进程即可。

| 遇到的情况         | 下一步                                       |
| ------------------ | -------------------------------------------- |
| 图片或记录无法保存 | 检查目录权限，或更换 `--output-dir`          |
| 文件已经存在       | 更换 `--filename`，或按需使用 `--overwrite`  |
| 部分图片成功       | 使用已保存的图片，再查看失败项的原因         |
| 超时或断网         | 到供应商后台确认请求状态，再决定是否重新生成 |
| 中断了命令         | 查看已保存结果；上游请求可能仍在处理         |
| 模型或参数报错     | 核对模型 ID 和供应商支持的参数值             |

## 在脚本中读取结果

给命令加上 `--json`，即可从标准输出读取一个 JSON 结果，进度信息会输出到标准错误。
例如：

```bash
imgrelay generate --prompt-file ./prompt.txt --output-dir ./images --json
```

脚本先检查 `status` 和 `error`，再确认 `data` 存在并读取 `data.images`。
成功保存的图片路径位于 `data.images[].path`；即使命令失败，也可能已经保存了部分图片。

| 常用字段                                    | 用途                                     |
| ------------------------------------------- | ---------------------------------------- |
| `status`                                    | 判断成功、部分成功或失败                 |
| `error.category`、`error.message`           | 读取错误类别和说明                       |
| `data.images`                               | 读取已保存图片的路径、格式、尺寸和字节数 |
| `data.failures`                             | 查看各图片条目的失败原因                 |
| `data.recordPath`                           | 查阅本地生成记录                         |
| `data.provider`、`data.requestedModel`      | 查看本次供应商和请求模型                 |
| `data.requestedCount`、`data.returnedCount` | 比较请求数量和返回数量                   |
| `data.parameters`                           | 查看本次生成参数                         |
| `data.submissionStatus`                     | 判断请求是否已提交或结果是否未知         |

### 状态和退出码

| `status`          | 含义                                              |
| ----------------- | ------------------------------------------------- |
| `success`         | 返回的图片均已保存，实际数量以 `data.images` 为准 |
| `partial_success` | 部分图片已保存，失败原因见 `data.failures`        |
| `error`           | 发生错误，详情见 `error` 或 `data.failures`       |
| `unknown`         | 请求结果未知，先到供应商后台确认                  |
| `interrupted`     | 命令被中断，先检查已有结果                        |

`data.submissionStatus` 为 `not_submitted` 时，请求尚未提交；为 `unknown` 时，提交结果未知。
读取提示词或离线预览失败时，`data` 可仅包含 `submissionStatus: not_submitted`，没有图片或摘要字段。
其他输入或配置错误仍可能返回 `data: null`；生成记录保存失败时，`data.recordPath` 可能为空。

| 退出码 | 含义                             |
| ------ | -------------------------------- |
| 0      | 成功                             |
| 1      | 内部错误                         |
| 2      | 输入、配置、凭据或参数校验错误   |
| 3      | 上游、图片响应错误或生成结果未知 |
| 4      | 图片或记录保存失败               |
| 5      | 部分图片成功                     |
| 130    | 用户中断                         |

## 供应商的进阶配置

### 调整 API 地址和端点

按照供应商说明填写 API 基础地址；通常包含 `/v1`。
供应商使用自定义端点时，可在配置中指定：

```bash
imgrelay provider edit relay --base-url https://relay.example/v1 --generation-path /render --models-path /catalog --json
```

使用 `generate --dry-run` 查看本次生成地址，或用 `doctor` 检查模型接口连接。

### 设置模型参数限制

如果供应商对某个模型有特定限制，可新建 `capabilities.json`：

```json
{
  "vendor-model": {
    "parameters": {
      "n": { "max": 1 },
      "quality": { "values": ["high"] }
    }
  }
}
```

导入后，生成时选择对应模型：

```bash
imgrelay provider edit relay --capabilities-file ./capabilities.json --json
imgrelay generate --prompt-file ./prompt.txt --provider relay --model vendor-model --quality high
```

可配置 `size`、`n`、`quality`、`outputFormat` 和 `responseFormat` 的限制。
按供应商提供的能力填写 `supported`、`values`、`min` 或 `max`。

### 配置选项速查

`provider add` 和 `provider edit` 可使用以下选项。
添加供应商或更新密钥时，在终端中使用交互命令；其他配置可直接通过选项修改。
只想应用命令中指定的设置时，加上 `--json` 跳过交互提问。

| 选项                                               | 用途                                          |
| -------------------------------------------------- | --------------------------------------------- |
| `--base-url <URL>`                                 | 设置 API 基础地址                             |
| `--protocol <协议>`                                | 设置协议，目前使用 `openai-images`            |
| `--preset <名称>`                                  | 使用供应商预设，目前提供 `cubence`            |
| `--model <ID>`                                     | 设置默认模型                                  |
| `--default`                                        | 设为默认供应商                                |
| `--clear-key`                                      | 清除已保存的密钥                              |
| `--size`、`--n`、`--quality`、`--output-format`    | 设置默认生成参数，各选项后填写对应值          |
| `--response-format <格式>`                         | 按供应商要求设置返回格式：`url` 或 `b64_json` |
| `--generation-path <路径>`、`--models-path <路径>` | 设置自定义 API 端点                           |
| `--capabilities-file <文件>`                       | 导入模型参数限制                              |
| `--timeout <秒数>`                                 | 设置默认生成等待时间                          |

## 配置位置与命令帮助

配置保存在用户主目录的 `~/.imgrelay/`，包含供应商设置和明文 API Key。
需要使用其他配置目录时，设置环境变量 `IMGRELAY_CONFIG_DIR`。

查看完整命令和选项：

```bash
imgrelay --help
imgrelay generate --help
imgrelay provider edit --help
imgrelay --version
```
