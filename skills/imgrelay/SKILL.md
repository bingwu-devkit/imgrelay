---
name: imgrelay
description: 通过本机 ImgRelay CLI 调用已配置的第三方中转站生成图片，并展示保存的原图；适用于用户指定中转站、供应商或 imgrelay 生图的请求。
---

# ImgRelay

使用 `imgrelay` CLI 管理调用和鉴权；CLI 独立安装，Skill 通过 Skills CLI 从仓库安装。
CLI 不存在时说明安装入口 `npm install -g imgrelay`。

## 配置与选择

运行 `imgrelay provider list --json` 获取非敏感摘要。使用用户明确指定的供应商和模型，
未指定时使用本机默认项。需要详细参数时运行 `imgrelay provider show <名称> --json`。
已有配置无需重新阅读供应商官网，不读取凭据文件或 API Key。

没有供应商时引导使用 `imgrelay provider add <名称>`；没有默认项时使用
`imgrelay provider use <名称>`。密钥仅由用户在交互终端通过 `provider add/edit` 隐藏输入，
并保存到 `config.json`；新增或输入新密钥时不加 `--json`，不在命令行写密钥内容。
只询问配置或能力时使用 `models`、`doctor`，不生成图片。

## 生成与呈现

用户明确要求生成时，准备与其主题、用途和显式约束一致的提示词。通用入口不固定风格。
通过 `--prompt` 直接传递非空提示词。长提示词也使用此选项，按当前 shell 正确引用
以保留引号、换行和特殊字符：

```bash
imgrelay generate --prompt "一只戴宇航员头盔的猫" --json
imgrelay generate --provider demo --model vendor-model --prompt "一只戴宇航员头盔的猫" --n 2 --json
```

通过 `--size`、`--quality`、`--output-format`、`--output-dir`、`--filename`、`--timeout`
传递需要的显式参数；未指定的参数交由 CLI 默认配置决定。只在用户要求覆盖已有文件时
增加 `--overwrite`。默认输出目录是当前工作目录的 `output/imagegen/`。

标准输出是一个 JSON 对象，进度在标准错误。读取 `status`、`data.images[].path`、
`data.requestedModel`、`data.provider`、实际宽高和 `data.recordPath`，通过当前环境可用的
图片展示工具显示本地文件，并说明使用的供应商、请求模型与保存位置。
仅当 `data.reportedModel` 存在时说明上游报告的模型；不据请求模型断言底层模型身份。

## 错误与部分结果

根据 `error.category` 和退出码处理：2 输入/配置、3 上游失败或结果未知、4 保存失败、
5 部分成功、130 用户中断。部分成功时展示已保存图片并说明失败项。
读取 JSON 后再决定下一步，不把非零退出码一律理解为没有图片。

超时或断网时上游可能仍在生成；不自动重提，不切换供应商或模型，不降低参数，不追加生成。
保存失败时使用已返回的文件路径，不能重新生图来恢复保存。不自动筛选、修图或裁剪原图。
生成任务本身不要求修改项目代码或替换已有产品图片；按用户明确要求使用结果。
