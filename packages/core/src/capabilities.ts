import { ImgRelayError } from './errors.js'
import { parameterSchema } from './schema.js'
import type { ModelCapability, Parameters, Provider } from './schema.js'

const GPT_IMAGE_CAPABILITY: ModelCapability = {
  source: 'official_documentation',
  sourceUrl: 'https://developers.openai.com/api/reference/python/resources/images/methods/generate',
  verifiedAt: '2026-10-10T10:03:00.000Z',
  parameters: {
    n: { min: 1, max: 10 },
    size: { values: ['auto', '1024x1024', '1536x1024', '1024x1536'] },
    quality: { values: ['auto', 'low', 'medium', 'high'] },
    outputFormat: { values: ['png', 'jpeg', 'webp'] },
    responseFormat: { supported: false },
  },
}
export const KNOWN_MODEL_CAPABILITIES: Readonly<Record<string, ModelCapability>> = {
  'gpt-image-1': GPT_IMAGE_CAPABILITY,
  'gpt-image-1-mini': GPT_IMAGE_CAPABILITY,
}

export function resolveParameters(
  provider: Provider,
  model: string,
  supplied: Parameters,
): Parameters {
  const parsed = parameterSchema.safeParse({ n: 1, ...provider.defaults, ...supplied })
  if (!parsed.success)
    throw new ImgRelayError('input_error', '生成参数无效：数量必须是正整数，各参数必须是非空字符串')
  const result = parsed.data
  const known = Object.hasOwn(KNOWN_MODEL_CAPABILITIES, model)
    ? KNOWN_MODEL_CAPABILITIES[model]
    : undefined
  const override = Object.hasOwn(provider.modelOverrides, model)
    ? provider.modelOverrides[model]
    : undefined
  const limits = { ...known?.parameters, ...override?.parameters }
  for (const name of ['size', 'n', 'quality', 'outputFormat', 'responseFormat'] as const) {
    const value = result[name]
    const limit = limits[name]
    if (value === undefined || !limit) continue
    if (
      limit.supported === false &&
      name === 'n' &&
      supplied.n === undefined &&
      provider.defaults.n === undefined
    ) {
      delete result.n
      continue
    }
    if (
      limit.supported === false ||
      (limit.values && !limit.values.includes(String(value))) ||
      (typeof value === 'number' &&
        ((limit.min !== undefined && value < limit.min) ||
          (limit.max !== undefined && value > limit.max)))
    ) {
      throw new ImgRelayError(
        'parameter_unsupported',
        `模型 ${model} 不支持参数 ${name}=${value}；请检查模型能力或供应商覆盖`,
        2,
      )
    }
  }
  return result
}
