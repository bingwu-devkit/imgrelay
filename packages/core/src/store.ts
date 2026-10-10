/* Sequential lock acquisition and stale-lock recovery must not run in parallel. */
/* eslint-disable no-await-in-loop */
import { lstat, mkdir, rmdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, parse, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { z } from 'zod'

import { ImgRelayError, Redactor } from './errors.js'
import { isNotFound, readJson, writeAtomic } from './files.js'
import { configSchema, parseProvider, providerNameSchema } from './schema.js'
import type { Config, Provider, ProviderInput } from './schema.js'

export function defaultConfigDirectory(): string {
  if (process.env.IMGRELAY_CONFIG_DIR) return resolve(process.env.IMGRELAY_CONFIG_DIR)
  return join(homedir(), '.imgrelay')
}

export class Store {
  readonly directory: string
  readonly redactor = new Redactor()
  private initialized = false

  constructor(directory = defaultConfigDirectory()) {
    this.directory = resolve(directory)
    if (this.directory === parse(this.directory).root) {
      throw new ImgRelayError('config_error', '配置目录不能是文件系统根目录')
    }
  }

  async config(): Promise<Config> {
    try {
      const raw = await readJson(join(this.directory, 'config.json'))
      if (raw && typeof raw === 'object' && 'schemaVersion' in raw && raw.schemaVersion !== 1)
        throw new ImgRelayError('config_error', '不支持此配置版本；当前仅支持 schemaVersion=1')
      const result = configSchema.safeParse(raw)
      if (!result.success)
        throw new ImgRelayError('config_error', '配置文件结构或版本无效；请检查 config.json')
      for (const provider of Object.values(result.data.providers)) {
        if (provider.apiKey) this.redactor.add(provider.apiKey)
      }
      return result.data
    } catch (error) {
      if (isNotFound(error)) return { schemaVersion: 1, providers: {} }
      if (error instanceof ImgRelayError) throw error
      throw new ImgRelayError('config_error', '无法读取配置文件；请检查文件格式及访问权限')
    }
  }

  async selected(name?: string): Promise<{ name: string; provider: Provider }> {
    const config = await this.config()
    const selected = name || config.defaultProvider
    if (!selected)
      throw new ImgRelayError(
        'config_error',
        '未设置默认供应商，请运行 imgrelay provider use <名称>',
      )
    const provider = Object.hasOwn(config.providers, selected)
      ? config.providers[selected]
      : undefined
    if (!provider)
      throw new ImgRelayError(
        'config_error',
        `供应商 ${selected} 不存在，请运行 imgrelay provider add ${selected}`,
      )
    return { name: selected, provider }
  }

  private async initialize(): Promise<void> {
    if (!this.initialized) {
      await mkdir(this.directory, { recursive: true })
      this.initialized = true
    }
  }

  private async locked<T>(operation: () => Promise<T>): Promise<T> {
    await this.initialize()
    const lock = join(this.directory, '.write-lock')
    const owner = join(lock, 'owner.json')
    const deadline = Date.now() + 10_000
    for (;;) {
      try {
        await mkdir(lock)
        break
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
        try {
          const data = z.object({ pid: z.number().int().positive() }).parse(await readJson(owner))
          try {
            process.kill(data.pid, 0)
          } catch (checkError) {
            if (
              checkError instanceof Error &&
              'code' in checkError &&
              checkError.code === 'ESRCH'
            ) {
              await unlink(owner)
              await rmdir(lock)
              continue
            }
          }
        } catch {
          // A process can stop between mkdir and writing the owner marker.
          try {
            if (Date.now() - (await lstat(lock)).mtimeMs > 60_000) {
              await unlink(owner).catch(() => {})
              await rmdir(lock)
              continue
            }
          } catch {
            /* another writer released the lock */
          }
        }
        if (Date.now() >= deadline)
          throw new ImgRelayError('config_busy', '配置正在被其他进程修改，请稍后重试')
        await delay(50)
      }
    }
    try {
      await writeFile(owner, JSON.stringify({ pid: process.pid }))
      return await operation()
    } finally {
      await unlink(owner).catch(() => {})
      await rmdir(lock).catch(() => {})
    }
  }

  async key(provider: Pick<Provider, 'apiKey'>): Promise<string> {
    const key = provider.apiKey
    if (!key)
      throw new ImgRelayError(
        'credential_error',
        '未配置 API 密钥，请运行 imgrelay provider edit <名称>',
      )
    if (/[\r\n\0]/.test(key))
      throw new ImgRelayError('credential_error', '密钥不能包含换行或空字符')
    this.redactor.add(key)
    return key
  }

  async put(
    name: string,
    input: ProviderInput,
    options: {
      edit?: boolean
      secret?: string
      makeDefault?: boolean
      expectedRevision?: number
    } = {},
  ): Promise<Provider> {
    if (!providerNameSchema.safeParse(name).success)
      throw new ImgRelayError('input_error', '供应商名称只能包含字母、数字、下划线和连字符')
    if (input.apiKey) this.redactor.add(input.apiKey)
    if (options.secret) this.redactor.add(options.secret)
    const proposed = parseProvider({
      ...input,
      ...(options.secret !== undefined ? { apiKey: options.secret } : {}),
    })
    if (proposed.apiKey) this.redactor.add(proposed.apiKey)
    return this.locked(async () => {
      const config = await this.config()
      const previous = Object.hasOwn(config.providers, name) ? config.providers[name] : undefined
      if (options.edit ? !previous : previous)
        throw new ImgRelayError(
          'config_error',
          options.edit ? '供应商不存在' : '供应商已存在，请使用 provider edit',
        )
      if (options.expectedRevision !== undefined && previous?.revision !== options.expectedRevision)
        throw new ImgRelayError('config_busy', '配置已被其他进程修改，请重新执行编辑')
      proposed.revision = (previous?.revision || 0) + 1
      config.providers[name] = proposed
      if (options.makeDefault) config.defaultProvider = name
      await writeAtomic(join(this.directory, 'config.json'), config)
      return proposed
    })
  }

  async use(name: string): Promise<void> {
    await this.locked(async () => {
      const config = await this.config()
      if (!Object.hasOwn(config.providers, name))
        throw new ImgRelayError('config_error', '供应商不存在')
      config.defaultProvider = name
      await writeAtomic(join(this.directory, 'config.json'), config)
    })
  }

  async remove(name: string): Promise<void> {
    await this.locked(async () => {
      const config = await this.config()
      if (!Object.hasOwn(config.providers, name))
        throw new ImgRelayError('config_error', '供应商不存在')
      delete config.providers[name]
      if (config.defaultProvider === name) delete config.defaultProvider
      await writeAtomic(join(this.directory, 'config.json'), config)
    })
  }

  async cache(): Promise<unknown> {
    try {
      return await readJson(join(this.directory, 'models-cache.json'))
    } catch {
      return {}
    }
  }

  async saveCache(key: string, value: unknown): Promise<void> {
    await this.locked(async () => {
      const parsed = z.record(z.string(), z.unknown()).safeParse(await this.cache())
      const cache = parsed.success ? parsed.data : {}
      cache[key] = value
      // Bound accumulated entries from old provider configurations.
      const entries = Object.entries(cache).slice(-100)
      await writeAtomic(join(this.directory, 'models-cache.json'), Object.fromEntries(entries))
    })
  }
}
