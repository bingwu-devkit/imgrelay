import { z } from 'zod'

import { ImgRelayError } from './errors.js'
import { normalizeAddress, validateEndpoint } from './urls.js'

const shortText = z.string().trim().min(1).max(256)
export const providerNameSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/)
export const parameterSchema = z.strictObject({
  size: shortText.optional(),
  n: z.number().int().positive().optional(),
  quality: shortText.optional(),
  outputFormat: shortText.optional(),
  responseFormat: z.enum(['url', 'b64_json']).optional(),
})
export const parameterCapabilitySchema = z.strictObject({
  supported: z.boolean().optional(),
  values: z.array(shortText).min(1).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
})
export const modelCapabilitySchema = z.strictObject({
  source: z
    .enum(['official_documentation', 'provider_override', 'call_verification'])
    .default('provider_override'),
  sourceUrl: z.url().optional(),
  verifiedAt: z.iso.datetime().optional(),
  parameters: z.strictObject({
    size: parameterCapabilitySchema.optional(),
    n: parameterCapabilitySchema.optional(),
    quality: parameterCapabilitySchema.optional(),
    outputFormat: parameterCapabilitySchema.optional(),
    responseFormat: parameterCapabilitySchema.optional(),
  }),
})
const endpointSchema = z
  .string()
  .max(1024)
  .refine((value) => {
    try {
      return validateEndpoint(value)
    } catch {
      return false
    }
  }, '端点必须是有效路径')
export const providerSchema = z
  .strictObject({
    protocol: z.literal('openai-images'),
    baseUrl: z.string(),
    apiKey: z
      .string()
      .trim()
      .min(1)
      .refine((key) => !/[\r\n\0]/.test(key), '密钥不能包含换行或空字符')
      .optional(),
    defaultModel: shortText.optional(),
    defaults: parameterSchema.default({}),
    endpoints: z
      .strictObject({ generate: endpointSchema.optional(), models: endpointSchema.optional() })
      .default({}),
    modelOverrides: z.record(shortText, modelCapabilitySchema).default({}),
    timeoutSeconds: z.number().positive().max(2_147_483).finite().default(600),
    revision: z.number().int().positive().default(1),
  })
  .transform((provider) => {
    const address = normalizeAddress(provider.baseUrl)
    return {
      ...provider,
      baseUrl: address.baseUrl,
      endpoints:
        address.generationPath && !provider.endpoints.generate
          ? { ...provider.endpoints, generate: address.generationPath }
          : provider.endpoints,
    }
  })
export const configSchema = z.strictObject({
  schemaVersion: z.literal(1),
  defaultProvider: providerNameSchema.optional(),
  providers: z.record(providerNameSchema, providerSchema),
})
export type Parameters = z.infer<typeof parameterSchema>
export type ModelCapability = z.infer<typeof modelCapabilitySchema>
export type Provider = z.infer<typeof providerSchema>
export type ProviderInput = z.input<typeof providerSchema>
export type Config = z.infer<typeof configSchema>

export function parseProvider(input: unknown): Provider {
  const result = providerSchema.safeParse(input)
  if (!result.success) {
    throw new ImgRelayError(
      'config_error',
      `供应商配置无效：${result.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join('；')}`,
    )
  }
  return result.data
}

export const CUBENCE_PRESET: ProviderInput = {
  protocol: 'openai-images',
  baseUrl: 'https://api-lb.cubence.ai/v1',
  defaultModel: 'gpt-image-2.5-flare',
  defaults: { size: 'auto', n: 1, quality: 'high', outputFormat: 'png' },
}
