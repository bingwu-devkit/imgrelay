import { Store } from '@imgrelay/core'

// 只查看配置摘要，不读取密钥或调用生成接口。
const store = new Store()
const config = await store.config()
console.log(
  JSON.stringify(
    {
      directory: store.directory,
      defaultProvider: config.defaultProvider || null,
      providers: Object.keys(config.providers),
    },
    null,
    2,
  ),
)
