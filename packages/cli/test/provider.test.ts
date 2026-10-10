import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import * as prompts from '@clack/prompts'
import { CUBENCE_PRESET, Store } from '@imgrelay/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { configureProvider } from '../src/provider.js'

vi.mock('@clack/prompts', async (importOriginal) => ({
  ...(await importOriginal<typeof prompts>()),
  intro: vi.fn<typeof prompts.intro>(),
  outro: vi.fn<typeof prompts.outro>(),
  password: vi.fn<typeof prompts.password>(),
  text: vi.fn<typeof prompts.text>(),
  select: vi.fn<typeof prompts.select>(),
  confirm: vi.fn<typeof prompts.confirm>(),
  log: { warn: vi.fn<typeof prompts.log.warn>() },
}))

const KEY = 'hidden-input-fixture-key'
const OLD_KEY = 'previous-fixture-key'
const flags = { baseUrl: 'https://relay.example/v1', model: 'vendor-model', default: true }
let directory: string
let store: Store
let signal: AbortSignal

beforeEach(async () => {
  vi.resetAllMocks()
  vi.mocked(prompts.password).mockResolvedValue(KEY)
  vi.mocked(prompts.confirm).mockResolvedValue(false)
  directory = await mkdtemp(join(tmpdir(), 'imgrelay-provider-'))
  store = new Store(directory)
  signal = new AbortController().signal
})

afterEach(async () => {
  if (!resolve(directory).startsWith(join(tmpdir(), 'imgrelay-provider-')))
    throw new Error('Unsafe test cleanup path')
  await rm(directory, { recursive: true, force: true })
})

describe('供应商隐藏密钥输入', () => {
  it('新增直接隐藏输入并保存到 config.json，新进程可读取且输出脱敏', async () => {
    const saved = await configureProvider(store, 'relay', flags, true, signal)
    expect(prompts.password).toHaveBeenCalledOnce()
    expect(prompts.select).not.toHaveBeenCalled()
    expect(await readFile(join(directory, 'config.json'), 'utf8')).toContain(KEY)
    const fresh = new Store(directory)
    const selected = await fresh.selected()
    expect(await fresh.key(selected.provider)).toBe(KEY)
    expect(JSON.stringify(fresh.redactor.value(saved))).not.toContain(KEY)
  })

  it.each([
    { input: '', expected: OLD_KEY },
    { input: KEY, expected: KEY },
  ])('修改输入 $input 时保存 $expected，保留其他配置', async ({ input, expected }) => {
    await store.put('relay', {
      protocol: 'openai-images',
      baseUrl: flags.baseUrl,
      defaultModel: flags.model,
      defaults: { quality: 'low' },
      apiKey: OLD_KEY,
    })
    const existing = (await store.selected('relay')).provider
    vi.mocked(prompts.password).mockResolvedValue(input)
    await configureProvider(store, 'relay', flags, true, signal, existing)
    const saved = (await new Store(directory).selected('relay')).provider
    expect(saved).toMatchObject({
      apiKey: expected,
      baseUrl: flags.baseUrl,
      defaultModel: flags.model,
      defaults: { quality: 'low' },
    })
    expect(prompts.password).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'API 密钥（留空保留当前密钥）' }),
    )
    expect(JSON.stringify(vi.mocked(prompts.password).mock.calls)).not.toContain(OLD_KEY)
  })

  it('取消密钥输入不写入供应商配置', async () => {
    vi.mocked(prompts.password).mockResolvedValue(prompts.CANCEL_SYMBOL)
    await expect(configureProvider(store, 'relay', flags, true, signal)).rejects.toMatchObject({
      category: 'interrupted',
      exitCode: 130,
    })
    await expect(readFile(join(directory, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('非交互新增直接报错，不请求密钥或保存配置', async () => {
    await expect(configureProvider(store, 'relay', flags, false, signal)).rejects.toMatchObject({
      category: 'config_error',
      exitCode: 2,
    })
    expect(prompts.password).not.toHaveBeenCalled()
    await expect(readFile(join(directory, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('明确清除密钥时跳过输入并从配置中移除密钥', async () => {
    await store.put('relay', { protocol: 'openai-images', baseUrl: flags.baseUrl, apiKey: OLD_KEY })
    const existing = (await store.selected('relay')).provider
    await configureProvider(store, 'relay', { ...flags, clearKey: true }, true, signal, existing)
    expect(prompts.password).not.toHaveBeenCalled()
    const selected = await new Store(directory).selected('relay')
    expect(selected.provider.apiKey).toBeUndefined()
    expect(await readFile(join(directory, 'config.json'), 'utf8')).not.toContain(OLD_KEY)
  })

  it('Cubence 预设仍保存已验证的默认组合', async () => {
    const saved = await configureProvider(
      store,
      'cubence',
      { preset: 'cubence', baseUrl: CUBENCE_PRESET.baseUrl, model: 'gpt-image-2.5-flare' },
      true,
      signal,
    )
    expect(saved).toMatchObject({ ...CUBENCE_PRESET, apiKey: KEY, modelOverrides: {} })
  })
})
