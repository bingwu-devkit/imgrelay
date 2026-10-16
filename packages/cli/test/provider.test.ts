import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import * as prompts from '@clack/prompts'
import { CUBENCE_PRESET, Store } from '@imgrelay/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { configureProvider, listProviders } from '../src/provider.js'

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

describe('列表选择默认供应商', () => {
  async function seed(makeDefault = true) {
    await store.put(
      'alpha',
      {
        protocol: 'openai-images',
        baseUrl: flags.baseUrl,
        defaultModel: 'alpha-model',
        apiKey: KEY,
      },
      { makeDefault },
    )
    await store.put('beta', {
      protocol: 'openai-images',
      baseUrl: 'https://other.example/v1',
    })
  }

  it.each([true, false])('回车选择后持久保存默认项（已有默认项：%s）', async (makeDefault) => {
    await seed(makeDefault)
    vi.mocked(prompts.select).mockResolvedValue('beta')
    const result = await listProviders(store, true, signal)
    expect((await new Store(directory).selected()).name).toBe('beta')
    expect(result.defaultProvider).toBe('beta')
    expect(result.providers.map(({ name, default: isDefault }) => ({ name, isDefault }))).toEqual([
      { name: 'alpha', isDefault: false },
      { name: 'beta', isDefault: true },
    ])
    const options = vi.mocked(prompts.select).mock.calls[0]?.[0]
    expect(options).toMatchObject({
      message: '选择默认供应商',
      options: [
        {
          value: 'alpha',
          label: makeDefault ? 'alpha（当前默认）' : 'alpha',
          hint: `alpha-model · ${flags.baseUrl}`,
        },
        { value: 'beta', label: 'beta', hint: '未设置默认模型 · https://other.example/v1' },
      ],
      signal,
    })
    expect(options?.initialValue).toBe(makeDefault ? 'alpha' : undefined)
  })

  it('保留当前默认项时不重写配置', async () => {
    await seed()
    const use = vi.spyOn(store, 'use')
    vi.mocked(prompts.select).mockResolvedValue('alpha')
    expect((await listProviders(store, true, signal)).defaultProvider).toBe('alpha')
    expect(use).not.toHaveBeenCalled()
  })

  it('取消选择保留原配置', async () => {
    await seed()
    const original = await readFile(join(directory, 'config.json'), 'utf8')
    vi.mocked(prompts.select).mockResolvedValue(prompts.CANCEL_SYMBOL)
    await expect(listProviders(store, true, signal)).rejects.toMatchObject({
      category: 'interrupted',
      exitCode: 130,
      message: '用户取消选择，默认供应商未更改',
    })
    expect(await readFile(join(directory, 'config.json'), 'utf8')).toBe(original)
  })

  it('选择期间收到中断信号不保存', async () => {
    await seed()
    const controller = new AbortController()
    vi.mocked(prompts.select).mockImplementation(() => {
      controller.abort()
      return Promise.resolve('beta')
    })
    await expect(listProviders(store, true, controller.signal)).rejects.toMatchObject({
      category: 'interrupted',
      exitCode: 130,
    })
    expect((await store.config()).defaultProvider).toBe('alpha')
  })

  it('非交互调用只返回摘要，不等待输入或修改默认项', async () => {
    await seed()
    const original = await readFile(join(directory, 'config.json'), 'utf8')
    expect(await listProviders(store, false, signal)).toMatchObject({
      defaultProvider: 'alpha',
      providers: [
        { name: 'alpha', credentialSource: 'config', default: true },
        { name: 'beta', credentialSource: null, default: false },
      ],
    })
    expect(prompts.select).not.toHaveBeenCalled()
    expect(await readFile(join(directory, 'config.json'), 'utf8')).toBe(original)
  })

  it('没有供应商时直接返回空列表，不创建配置', async () => {
    expect(await listProviders(store, true, signal)).toEqual({
      defaultProvider: null,
      providers: [],
    })
    expect(prompts.select).not.toHaveBeenCalled()
    await expect(readFile(join(directory, 'config.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('选择界面中的地址和模型脱敏', async () => {
    await store.put('relay', {
      protocol: 'openai-images',
      baseUrl: `https://relay.example/${KEY}/v1`,
      defaultModel: `model-${KEY}`,
      apiKey: KEY,
    })
    vi.mocked(prompts.select).mockResolvedValue('relay')
    await listProviders(store, true, signal)
    const displayed = JSON.stringify(vi.mocked(prompts.select).mock.calls)
    expect(displayed).not.toContain(KEY)
    expect(displayed).toContain('[REDACTED]')
  })
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
