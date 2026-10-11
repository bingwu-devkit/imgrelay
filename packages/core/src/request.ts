import { createHash } from 'node:crypto'
import { basename, parse, resolve } from 'node:path'

import { KNOWN_MODEL_CAPABILITIES, resolveParameters } from './capabilities.js'
import { ImgRelayError } from './errors.js'
import type { GenerateOptions } from './generate.js'
import type { ModelCapability, Parameters, Provider } from './schema.js'
import type { Store } from './store.js'
import { resolveEndpoint } from './urls.js'

export type PromptSource = { type: 'file'; path: string } | { type: 'stdin' } | { type: 'api' }
type ValueSource = 'explicit' | 'provider_default' | 'tool_default'

export interface RequestDetails {
  promptSource: PromptSource
  promptSha256: string
  /** JavaScript UTF-16 code units, matching String.length. */
  promptCharacters: number
  promptUtf8Bytes: number
  provider: string
  requestedModel: string
  parameters: Parameters
  endpoint: string
  capabilityEvidence: { known: ModelCapability | null; provider: ModelCapability | null }
  outputDir: string
  filename: string | null
  overwrite: boolean
  timeoutSeconds: number
  sources: {
    provider: 'explicit' | 'default'
    model: 'explicit' | 'provider_default'
    parameters: Partial<Record<keyof Parameters, ValueSource>>
    outputDir: 'explicit' | 'tool_default'
    filename: 'explicit' | 'tool_default'
    overwrite: 'explicit' | 'tool_default'
    timeoutSeconds: 'explicit' | 'provider_default'
  }
}

const parameterNames = ['size', 'n', 'quality', 'outputFormat', 'responseFormat'] as const

/** Resolve local configuration without requiring credentials, network or filesystem writes. */
export async function prepareRequest(store: Store, options: GenerateOptions) {
  if (!options.prompt.trim()) throw new ImgRelayError('input_error', '提示词不能为空')
  for (const name of ['provider', 'model', 'outputDir'] as const) {
    if (options[name] !== undefined && !options[name].trim())
      throw new ImgRelayError('input_error', `${name} 不能为空`)
  }
  if (
    options.timeoutSeconds !== undefined &&
    (!Number.isFinite(options.timeoutSeconds) ||
      options.timeoutSeconds <= 0 ||
      options.timeoutSeconds > 2_147_483)
  )
    throw new ImgRelayError('input_error', '超时必须是有效的正数秒数')
  if (
    options.filename !== undefined &&
    (!options.filename ||
      basename(options.filename) !== options.filename ||
      /[<>:"/\\|?*]/.test(options.filename) ||
      options.filename.split('').some((character) => character.charCodeAt(0) < 32) ||
      !parse(options.filename).name ||
      ['.', '..'].includes(options.filename))
  )
    throw new ImgRelayError('input_error', '--filename 必须是普通文件名，保存目录使用 --output-dir')
  const selected = await store.selected(options.provider)
  const model = (options.model ?? selected.provider.defaultModel ?? '').trim()
  if (!model)
    throw new ImgRelayError(
      'config_error',
      '未配置默认模型，请通过 --model 指定或运行 provider edit',
    )
  const supplied: Parameters = {}
  const parameterSources: RequestDetails['sources']['parameters'] = {}
  for (const name of parameterNames) {
    const value = options[name]
    if (value !== undefined) Object.assign(supplied, { [name]: value })
    if (value !== undefined) parameterSources[name] = 'explicit'
    else if (selected.provider.defaults[name] !== undefined)
      parameterSources[name] = 'provider_default'
    else if (name === 'n') parameterSources.n = 'tool_default'
  }
  const details: RequestDetails = {
    promptSource: options.promptSource ?? { type: 'api' },
    promptSha256: createHash('sha256').update(options.prompt, 'utf8').digest('hex'),
    promptCharacters: options.prompt.length,
    promptUtf8Bytes: Buffer.byteLength(options.prompt, 'utf8'),
    provider: selected.name,
    requestedModel: model,
    parameters: { n: 1, ...selected.provider.defaults, ...supplied },
    endpoint: resolveEndpoint(
      selected.provider.baseUrl,
      selected.provider.endpoints.generate || '/v1/images/generations',
    ),
    capabilityEvidence: {
      known: Object.hasOwn(KNOWN_MODEL_CAPABILITIES, model)
        ? KNOWN_MODEL_CAPABILITIES[model] || null
        : null,
      provider: Object.hasOwn(selected.provider.modelOverrides, model)
        ? selected.provider.modelOverrides[model] || null
        : null,
    },
    outputDir: resolve(options.outputDir ?? 'output/imagegen'),
    filename: options.filename ?? null,
    overwrite: Boolean(options.overwrite),
    timeoutSeconds: options.timeoutSeconds ?? selected.provider.timeoutSeconds,
    sources: {
      provider: options.provider !== undefined ? 'explicit' : 'default',
      model: options.model !== undefined ? 'explicit' : 'provider_default',
      parameters: parameterSources,
      outputDir: options.outputDir !== undefined ? 'explicit' : 'tool_default',
      filename: options.filename !== undefined ? 'explicit' : 'tool_default',
      overwrite: options.overwrite ? 'explicit' : 'tool_default',
      timeoutSeconds: options.timeoutSeconds !== undefined ? 'explicit' : 'provider_default',
    },
  }
  return { details, provider: selected.provider, supplied }
}

export function validateRequest(prepared: {
  details: RequestDetails
  provider: Provider
  supplied: Parameters
}): void {
  prepared.details.parameters = resolveParameters(
    prepared.provider,
    prepared.details.requestedModel,
    prepared.supplied,
  )
  for (const name of parameterNames) {
    if (prepared.details.parameters[name] === undefined)
      delete prepared.details.sources.parameters[name]
  }
}

export interface GenerationPreview extends RequestDetails {
  dryRun: true
  credentialConfigured: boolean
  submissionStatus: 'not_submitted'
  willSubmitNetworkRequest: false
}

export async function previewGenerate(
  store: Store,
  options: GenerateOptions,
): Promise<GenerationPreview> {
  const prepared = await prepareRequest(store, options)
  validateRequest(prepared)
  if (options.signal?.aborted)
    throw new ImgRelayError('interrupted', '用户中断，未提交生成请求', 130)
  return {
    ...prepared.details,
    dryRun: true,
    credentialConfigured: Boolean(prepared.provider.apiKey),
    submissionStatus: 'not_submitted',
    willSubmitNetworkRequest: false,
  }
}
