---
'imgrelay': minor
---

移除 `generate --prompt`，统一使用互斥的 `--prompt-file` 和 `--prompt-stdin`，避免 Windows 启动脚本截断多行及长提示词。严格读取 UTF-8，去除开头一个编码 BOM，其余文本原样保留。

新增无需密钥、完全只读的 `generate --dry-run`，预览原始提示词 SHA-256、UTF-16 字符数、UTF-8 字节数、有效请求配置和参数来源；正式结果及生成记录增加同样的完整性元数据。同步 Windows 使用示例、CLI 参考和仓库 Skill，并增加离线 mock 与安装入口回归。
