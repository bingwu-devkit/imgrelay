/* Interactive prompts must be shown one at a time. */
/* eslint-disable no-await-in-loop */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import * as prompts from '@clack/prompts'
import { CUBENCE_PRESET, discoverModels, ImgRelayError, parseProvider } from '@imgrelay/core'
import type { Provider, ProviderInput, Store } from '@imgrelay/core'
import type { Command } from 'commander'

export interface ProviderFlags {
  baseUrl?: string
  protocol?: string
  preset?: string
  model?: string
  clearKey?: boolean
  size?: string
  n?: string
  quality?: string
  outputFormat?: string
  responseFormat?: string
  generationPath?: string
  modelsPath?: string
  capabilitiesFile?: string
  timeout?: string
  default?: boolean
}

function answer(value: string | symbol): string
function answer(value: boolean | symbol): boolean
function answer(value: string | boolean | symbol): string | boolean {
  if (typeof value === 'symbol')
    throw new ImgRelayError('interrupted', '用户取消配置，未保存修改', 130)
  return value
}

export function providerOptions(command: Command): Command {
  return command
    .option('--base-url <URL>', 'API 基础地址，推荐包含 /v1')
    .option('--protocol <协议>', '首版支持 openai-images')
    .option('--preset <名称>', '使用已验证配置预设：cubence')
    .option('--model <ID>', '默认模型，允许手动填写')
    .option('--clear-key', '清除配置中保存的密钥')
    .option('--default', '保存后设为默认供应商')
    .option('--size <尺寸>', '默认尺寸')
    .option('--n <数量>', '默认生成数量')
    .option('--quality <质量>', '默认质量')
    .option('--output-format <格式>', '默认图片格式')
    .option('--response-format <格式>', '供应商要求的返回格式：url 或 b64_json')
    .option('--generation-path <路径>', '生成端点覆盖')
    .option('--models-path <路径>', '模型端点覆盖')
    .option('--capabilities-file <文件>', '按模型的能力覆盖 JSON 文件')
    .option('--timeout <秒数>', '默认生成超时')
}

export async function listProviders(store: Store, interactive: boolean, signal: AbortSignal) {
  let config = await store.config()
  const entries = Object.entries(config.providers)
  if (interactive && entries.length) {
    const selected = await prompts.select({
      message: '选择默认供应商',
      ...(config.defaultProvider ? { initialValue: config.defaultProvider } : {}),
      options: entries.map(([name, entry]) => ({
        value: name,
        label: store.redactor.text(
          `${name}${name === config.defaultProvider ? '（当前默认）' : ''}`,
        ),
        hint: store.redactor.text(`${entry.defaultModel || '未设置默认模型'} · ${entry.baseUrl}`),
      })),
      signal,
    })
    if (typeof selected === 'symbol' || signal.aborted)
      throw new ImgRelayError('interrupted', '用户取消选择，默认供应商未更改', 130)
    if (selected !== config.defaultProvider) await store.use(selected)
    config = await store.config()
    prompts.outro(store.redactor.text(`默认供应商：${config.defaultProvider}`))
  }
  return {
    defaultProvider: config.defaultProvider || null,
    providers: Object.entries(config.providers).map(([name, entry]) => ({
      name,
      protocol: entry.protocol,
      baseUrl: entry.baseUrl,
      defaultModel: entry.defaultModel || null,
      credentialSource: entry.apiKey ? 'config' : null,
      default: name === config.defaultProvider,
    })),
  }
}

export async function configureProvider(
  store: Store,
  name: string,
  flags: ProviderFlags,
  interactive: boolean,
  signal: AbortSignal,
  existing?: Provider,
): Promise<Provider> {
  if (flags.preset && flags.preset !== 'cubence')
    throw new ImgRelayError('input_error', '未知预设；当前提供 cubence')
  if (!existing && !interactive)
    throw new ImgRelayError(
      'config_error',
      '新增供应商需要隐藏输入 API 密钥，请在交互终端不带 --json 运行 provider add',
    )
  const input: ProviderInput = {
    protocol: 'openai-images',
    baseUrl: '',
    ...(flags.preset ? CUBENCE_PRESET : {}),
    ...existing,
  }
  if (flags.protocol) {
    if (flags.protocol !== 'openai-images')
      throw new ImgRelayError('config_error', '首版仅支持 openai-images 协议')
    input.protocol = flags.protocol
  }
  if (flags.baseUrl !== undefined) input.baseUrl = flags.baseUrl
  if (flags.model !== undefined) input.defaultModel = flags.model
  input.defaults = { ...input.defaults }
  input.endpoints = { ...input.endpoints }
  if (flags.size !== undefined) input.defaults.size = flags.size
  if (flags.n !== undefined) input.defaults.n = Number(flags.n)
  if (flags.quality !== undefined) input.defaults.quality = flags.quality
  if (flags.outputFormat !== undefined) input.defaults.outputFormat = flags.outputFormat
  if (flags.responseFormat !== undefined) {
    if (flags.responseFormat !== 'url' && flags.responseFormat !== 'b64_json')
      throw new ImgRelayError('input_error', '返回格式只能是 url 或 b64_json')
    input.defaults.responseFormat = flags.responseFormat
  }
  if (flags.generationPath !== undefined) input.endpoints.generate = flags.generationPath
  if (flags.modelsPath !== undefined) input.endpoints.models = flags.modelsPath
  if (flags.timeout !== undefined) input.timeoutSeconds = Number(flags.timeout)
  if (flags.capabilitiesFile) {
    try {
      const modelOverrides: unknown = JSON.parse(
        await readFile(resolve(flags.capabilitiesFile), 'utf8'),
      )
      input.modelOverrides = parseProvider({ ...input, modelOverrides }).modelOverrides
    } catch {
      throw new ImgRelayError('input_error', '能力覆盖文件必须是可读的 UTF-8 JSON')
    }
  }
  let secret: string | undefined
  if (flags.clearKey) delete input.apiKey
  if (interactive) {
    prompts.intro(existing ? `编辑供应商 ${name}` : `添加供应商 ${name}`)
    if (flags.baseUrl === undefined)
      input.baseUrl = answer(
        await prompts.text({
          message: 'API 基础地址',
          initialValue: input.baseUrl,
          validate: (value) => (value?.trim() ? undefined : '请输入地址'),
        }),
      )
    if (!flags.clearKey) {
      secret =
        answer(
          await prompts.password({
            message: input.apiKey ? 'API 密钥（留空保留当前密钥）' : 'API 密钥',
            validate: (value) => (value?.trim() || input.apiKey ? undefined : '密钥不能为空'),
          }),
        ).trim() || undefined
      if (secret) store.redactor.add(secret)
    }
  }
  if (!existing && !secret) throw new ImgRelayError('config_error', '新增供应商需要非空 API 密钥')
  if (interactive && flags.model === undefined) {
    let ids: string[] = []
    try {
      const key = secret || (await store.key(input))
      ids = (await discoverModels(parseProvider(input), key, store.redactor, signal)).map(
        (model) => model.id,
      )
    } catch (error) {
      if (error instanceof ImgRelayError && error.category === 'interrupted') throw error
      prompts.log.warn('未能查询模型列表，可以手动填写模型 ID；生成能力尚未验证')
    }
    const choice = ids.length
      ? answer(
          await prompts.select({
            message: '默认模型',
            options: [
              ...ids.map((id) => ({ value: id, label: store.redactor.text(id) })),
              { value: '\0manual', label: '手动填写模型 ID' },
            ],
          }),
        )
      : '\0manual'
    input.defaultModel =
      choice === '\0manual'
        ? answer(
            await prompts.text({
              message: '默认模型（留空可稍后设置）',
              initialValue: input.defaultModel || '',
            }),
          )
        : choice
    if (!input.defaultModel) delete input.defaultModel
  }
  if (
    interactive &&
    answer(
      await prompts.confirm({
        message: '设置尺寸、数量、质量和格式的默认值？',
        initialValue: false,
      }),
    )
  ) {
    for (const [field, label] of [
      ['size', '尺寸'],
      ['n', '数量'],
      ['quality', '质量'],
      ['outputFormat', '图片格式'],
    ] as const) {
      const value = answer(
        await prompts.text({
          message: `${label}（留空表示不设置）`,
          initialValue: String(input.defaults[field] || ''),
        }),
      )
      if (value) Object.assign(input.defaults, { [field]: field === 'n' ? Number(value) : value })
      else delete input.defaults[field]
    }
  }
  const makeDefault =
    flags.default ||
    (interactive
      ? answer(
          await prompts.confirm({
            message: '设为默认供应商？',
            initialValue: !(await store.config()).defaultProvider,
          }),
        )
      : false)
  const saved = await store.put(name, input, {
    ...(existing ? { edit: true, expectedRevision: existing.revision } : {}),
    ...(secret ? { secret } : {}),
    makeDefault,
  })
  if (interactive) prompts.outro('配置已保存；此流程没有生成图片')
  return saved
}
