import { createHash } from 'node:crypto'

import { z } from 'zod'

import { ImgRelayError } from './errors.js'
import type { ErrorInfo, Redactor } from './errors.js'
import { requestJson } from './http.js'
import type { Store } from './store.js'
import type { Provider } from './schema.js'
import { resolveEndpoint } from './urls.js'

const modelsResponse = z.object({
  data: z.array(z.object({ id: z.string().min(1), type: z.string().optional() })),
})
const cachedModels = z.object({
  fetchedAt: z.iso.datetime(),
  models: modelsResponse.shape.data,
  url: z.string(),
  revision: z.number(),
})
export type ModelList = z.infer<typeof cachedModels> & { provider: string; cached: boolean }

export async function discoverModels(
  provider: Provider,
  key: string,
  redactor: Redactor,
  signal?: AbortSignal,
): Promise<z.infer<typeof modelsResponse>['data']> {
  const url = resolveEndpoint(provider.baseUrl, provider.endpoints.models || '/v1/models')
  const response = modelsResponse.safeParse(
    await requestJson({ url, key, redactor, retry: true, ...(signal ? { signal } : {}) }),
  )
  if (!response.success)
    throw new ImgRelayError(
      'invalid_response',
      '模型接口未返回 data[].id；仍可手动配置模型后生成',
      3,
    )
  return response.data.data
}

export async function models(
  store: Store,
  options: { provider?: string; refresh?: boolean; signal?: AbortSignal } = {},
): Promise<ModelList> {
  const selected = await store.selected(options.provider)
  const key = await store.key(selected.provider)
  const url = resolveEndpoint(
    selected.provider.baseUrl,
    selected.provider.endpoints.models || '/v1/models',
  )
  const cacheKey = createHash('sha256')
    .update(JSON.stringify([selected.name, url, selected.provider.revision, key]))
    .digest('hex')
  if (!options.refresh) {
    const cache = z.record(z.string(), z.unknown()).safeParse(await store.cache())
    const cached = cachedModels.safeParse(cache.success ? cache.data[cacheKey] : undefined)
    if (
      cached.success &&
      Date.now() - Date.parse(cached.data.fetchedAt) >= 0 &&
      Date.now() - Date.parse(cached.data.fetchedAt) < 15 * 60_000
    ) {
      return { ...cached.data, provider: selected.name, cached: true }
    }
  }
  const discovered = await discoverModels(selected.provider, key, store.redactor, options.signal)
  const result = {
    fetchedAt: new Date().toISOString(),
    models: discovered,
    url,
    revision: selected.provider.revision,
  }
  await store.saveCache(cacheKey, result)
  return { ...result, provider: selected.name, cached: false }
}

export async function doctor(
  store: Store,
  options: { provider?: string; signal?: AbortSignal } = {},
): Promise<{ data: unknown; exitCode: number; error?: ErrorInfo }> {
  let selected: Awaited<ReturnType<Store['selected']>>
  try {
    selected = await store.selected(options.provider)
  } catch (error) {
    const info = store.redactor.error(error)
    return {
      exitCode: error instanceof ImgRelayError ? error.exitCode : 1,
      error: info,
      data: {
        provider: options.provider || null,
        endpoints: null,
        configuration: 'invalid',
        authentication: 'not_checked',
        modelDiscovery: { status: 'not_checked' },
        generation: 'not_verified',
      },
    }
  }
  const endpoints = {
    generate: resolveEndpoint(
      selected.provider.baseUrl,
      selected.provider.endpoints.generate || '/v1/images/generations',
    ),
    models: resolveEndpoint(
      selected.provider.baseUrl,
      selected.provider.endpoints.models || '/v1/models',
    ),
  }
  try {
    const result = await models(store, { ...options, refresh: true })
    return {
      exitCode: 0,
      data: {
        provider: selected.name,
        endpoints,
        configuration: 'valid',
        authentication: 'verified_for_models',
        modelDiscovery: result,
        generation: 'not_verified',
        defaultModelListed: selected.provider.defaultModel
          ? result.models.some((model) => model.id === selected.provider.defaultModel)
          : null,
      },
    }
  } catch (error) {
    if (error instanceof ImgRelayError && error.category === 'interrupted') throw error
    const info = store.redactor.error(error)
    return {
      exitCode: error instanceof ImgRelayError ? error.exitCode : 1,
      error: info,
      data: {
        provider: selected.name,
        endpoints,
        configuration: 'valid',
        authentication: info.category === 'auth_error' ? 'failed' : 'unknown',
        modelDiscovery: { status: 'unavailable', error: info },
        generation: 'not_verified',
        message: '模型列表不可用时，仍可手动设置模型；生成能力尚未验证',
      },
    }
  }
}
