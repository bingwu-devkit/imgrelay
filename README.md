# ImgRelay

在 Codex 中用自然语言调用第三方中转站生成图片，保存并展示原图。
配置一次供应商、密钥和默认模型，即可在不同项目中复用。

ImgRelay 提供负责配置和生图的 CLI，以及负责准备提示词、调用 CLI 和展示结果的 Codex Skill。
支持 OpenAI Images 兼容接口的文生图。

## 快速上手

### 1. 安装 CLI 和 Skill

需要 Node.js 22.20+（22.x）或 24.x。在终端运行：

```bash
npm install -g imgrelay
npx skills add bingwu-devkit/imgrelay --skill imgrelay
```

按 Skills CLI 的提示选择 Codex、安装范围和安装方式。

### 2. 配置中转站

打开终端运行，`relay` 是你为供应商取的名称：

```bash
imgrelay provider add relay --default
```

按提示填写 API 基础地址、API Key 和默认模型。地址通常形如
`https://relay.example/v1`；密钥通过隐藏输入填写，模型列表不可用时可手动输入模型 ID。

使用 Cubence 时，可通过预设填写地址和默认参数：

```bash
imgrelay provider add cubence --preset cubence --default
```

配置保存在用户主目录的 `~/.imgrelay/`，跨项目复用。API Key 以明文保存在本机配置中，
通过上述交互命令输入即可。

### 3. 在 Codex 中生成图片

进入要保存图片的项目，向 Codex 发出请求，例如：

```text
$imgrelay 生成一张戴宇航员头盔的猫，用作博客封面，横版。

用 imgrelay 的 relay 供应商生成两张极简风格的森林插画，保存到 ./images。

用 imgrelay 生图，提示词请原样使用：一只橘猫趴在窗边，午后自然光。
```

可在请求中指定供应商、模型、数量、尺寸或保存位置，其余设置沿用本机默认配置。
对于简短需求，Codex 会围绕用途补足提示词；需要使用现成提示词时，说明“原样使用”即可。

生成后，Codex 会展示已保存的图片，并说明供应商、请求模型和保存位置。
默认输出在当前项目的 `output/imagegen/`，包含原图和生成记录。

## 直接使用 CLI

### 从提示词文件生成

新建 `prompt.txt`，写入想要生成的内容，例如：

```text
一只戴宇航员头盔的猫，蓝色背景。
完整角色，横向构图，适合作为博客封面。
```

在文件所在目录运行：

```bash
imgrelay generate --prompt-file ./prompt.txt
```

### 指定保存位置

```bash
imgrelay generate --prompt-file ./prompt.txt --output-dir ./images --filename cat.png
```

### 选择供应商、模型或数量

```bash
imgrelay generate --prompt-file ./prompt.txt --provider relay --model vendor-model --n 2
```

`relay` 使用你已配置的供应商名称，`vendor-model` 替换为该供应商提供的模型 ID。
本次指定的设置仅用于这次生成。尺寸、质量和格式等选项见 [CLI 参考](https://github.com/bingwu-devkit/imgrelay/blob/main/docs/cli-reference.md)。

### 先预览配置（可选）

想先查看本次使用的模型、参数和保存位置时，加上 `--dry-run`：

```bash
imgrelay generate --prompt-file ./prompt.txt --dry-run --json
```

这条命令只预览配置，不生成图片，也不消耗生图额度。

## 管理配置

| 常用命令                           | 用途                           |
| ---------------------------------- | ------------------------------ |
| `imgrelay provider list`           | 查看并交互选择默认供应商       |
| `imgrelay provider show relay`     | 查看供应商配置                 |
| `imgrelay provider edit relay`     | 修改地址、密钥、模型和默认参数 |
| `imgrelay provider use relay`      | 切换默认供应商                 |
| `imgrelay models --provider relay` | 查询可用模型                   |
| `imgrelay doctor --provider relay` | 检查配置和模型接口连接         |

命令后加 `--help` 可查看完整选项。需要在脚本中读取结果时加 `--json`；
添加供应商和更新密钥时，使用上表中的交互命令。

在终端运行 `imgrelay provider list`，按上下键选择、回车设为默认供应商，当前默认项会预选并标记。
按 Esc 或 Ctrl+C 取消，不修改配置。加 `--json` 或通过管道调用时只输出列表。

## 常见问题

**图片保存在哪里？** 默认在运行命令的目录下的 `output/imagegen/`。
用 `--output-dir` 指定其他目录，生成结果中也会显示保存路径。

**文件已经存在怎么办？** 更换 `--filename`，或在需要覆盖时加 `--overwrite`。

**找不到想用的模型怎么办？** 根据供应商提供的模型 ID，用 `--model` 指定；
也可以运行 `provider edit` 修改默认模型。

**生成等了很久怎么办？** 默认等待 10 分钟，可用 `--timeout` 调整等待秒数。
超时或断网后，先到供应商后台确认请求状态，再决定是否重新生成。

**只有部分图片成功怎么办？** 已保存的图片仍可使用，查看结果中的失败原因，
再决定是否需要生成更多图片。

## 详细文档

- [CLI 参考](https://github.com/bingwu-devkit/imgrelay/blob/main/docs/cli-reference.md)：按场景使用命令、配置选项、脚本调用与问题处理。
- [开发与发布](https://github.com/bingwu-devkit/imgrelay/blob/main/docs/development.md)：源码运行、验证、打包和发布流程。

## 许可证

[MIT](./LICENSE.md)。

## 友情链接

https://linux.do
