# ImgRelay

在 Codex 中用自然语言调用第三方中转站生成图片，保存并展示原图。
配置一次供应商、密钥和默认模型，即可在不同项目中复用。

ImgRelay 由 CLI 和 Codex Skill 组成：CLI 负责配置、请求和文件保存，Skill 负责理解需求、
准备提示词和呈现结果。目前支持 OpenAI Images 兼容接口的文生图。

## 快速上手

### 1. 安装 CLI 和 Skill

需要 Node.js 22.20+（22.x）或 24.x。在终端运行：

```bash
npm install -g imgrelay
npx skills add bingwu-devkit/imgrelay --skill imgrelay
```

两者分开安装：npm 安装提供 `imgrelay` 命令，Skills CLI 安装 Skill。
按 Skills CLI 的提示选择 Codex、安装范围和安装方式。

### 2. 配置中转站

在交互终端中运行，`relay` 是你为供应商取的名称：

```bash
imgrelay provider add relay
imgrelay provider use relay
imgrelay doctor --provider relay
```

按提示输入 API 基础地址、API Key 并选择默认模型；地址通常形如
`https://relay.example/v1`。密钥隐藏输入，模型列表不可用时可以手动填写模型 ID。
完成交互后统一保存配置，这个流程不会生成图片。

使用 Cubence 时，可以用预设创建配置并设为默认：

```bash
imgrelay provider add cubence --preset cubence --default
```

配置保存在用户主目录的 `~/.imgrelay/`，跨项目复用。API Key 明文存储在 `config.json`，
请通过上述交互命令输入密钥，无需发给 Codex。`doctor` 检查配置和模型接口；
检查成功不代表所有生成参数都可用。

### 3. 在 Codex 中生成图片

进入要保存图片的项目，向 Codex 发出请求，例如：

```text
$imgrelay 生成一张戴宇航员头盔的猫，用作博客封面，横版。

用 imgrelay 的 relay 供应商生成两张极简风格的森林插画，保存到 ./images。

用 imgrelay 生图，提示词请原样使用：一只橘猫趴在窗边，午后自然光。
```

Skill 使用你指定的供应商、模型和参数，未指定时沿用本机默认配置。
对于简短需求，Codex 会围绕用途补足提示词；明确要求原样使用时保留原文。
生成后展示已保存的图片，并说明供应商、请求模型和保存位置。

默认输出在当前工作目录的 `output/imagegen/`，包含原图和生成记录。
也可以在请求中指定目录或文件名。

## 直接使用 CLI

不通过 Codex 也可以生成图片：

```bash
imgrelay generate --prompt "一只戴宇航员头盔的猫"
imgrelay generate --provider relay --prompt "极简风格的森林插画" --n 2 --json
imgrelay generate --prompt "一只橘猫趴在窗边" --output-dir ./images --filename cat.png
```

本次参数覆盖不会修改默认配置。CLI 原样发送 `--prompt`，不自动改写提示词。
尺寸、质量和格式是否可用取决于模型与供应商；完整选项见 `imgrelay generate --help`。

| 常用命令                           | 用途                           |
| ---------------------------------- | ------------------------------ |
| `imgrelay provider list`           | 查看供应商和默认项             |
| `imgrelay provider show relay`     | 查看供应商的脱敏配置           |
| `imgrelay provider edit relay`     | 修改配置或通过隐藏输入更新密钥 |
| `imgrelay provider use relay`      | 切换默认供应商                 |
| `imgrelay models --provider relay` | 查询模型列表，支持 `--refresh` |
| `imgrelay doctor --provider relay` | 检查配置和模型接口，不生成图片 |

命令支持 `--help` 和 `--json`。JSON 模式关闭交互，标准输出只有一个最终 JSON，
进度输出到标准错误；新增供应商或更新密钥时使用不带 `--json` 的交互命令。

## 使用须知

- 图片按原始字节保存，默认不覆盖已有文件；需要覆盖时显式使用 `--overwrite`。
- 生成默认等待 600 秒。超时或断网后，上游可能仍在生成；工具不会自动重提、换模型或补单。
- 部分图片失败时仍保留已保存的结果；非零退出码不一定意味着没有图片。
- 模型列表不可用时仍可手动指定模型；图片编辑及非 OpenAI Images 协议目前不支持。

## 详细文档

- [CLI 参考](https://github.com/bingwu-devkit/imgrelay/blob/main/docs/cli-reference.md)：完整命令、兼容配置、存储方式、JSON 结果与退出码。
- [开发与发布](https://github.com/bingwu-devkit/imgrelay/blob/main/docs/development.md)：源码运行、验证、打包和发布流程。

## 许可证

[MIT](./LICENSE.md)。
