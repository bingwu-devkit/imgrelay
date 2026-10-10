/* Redirects and per-image processing are bounded and preserve result order. */
/* eslint-disable no-await-in-loop */
import { randomUUID } from 'node:crypto'
import { access, mkdir, open, unlink, writeFile } from 'node:fs/promises'
import { basename, join, parse, resolve } from 'node:path'

import { fileTypeFromBuffer } from 'file-type'
import { imageSize } from 'image-size'

import { KNOWN_MODEL_CAPABILITIES, resolveParameters } from './capabilities.js'
import { ImgRelayError } from './errors.js'
import type { ErrorInfo } from './errors.js'
import { isNotFound, writeAtomic } from './files.js'
import { MAX_IMAGE_BYTES, readBounded, requestJson } from './http.js'
import type { ModelCapability, Parameters } from './schema.js'
import type { Store } from './store.js'
import { resolveEndpoint } from './urls.js'

export interface GenerateOptions extends Parameters {
  prompt: string
  provider?: string
  model?: string
  outputDir?: string
  filename?: string
  overwrite?: boolean
  timeoutSeconds?: number
  signal?: AbortSignal
  progress?: (message: string) => void
}
export interface SavedImage {
  index: number
  path: string
  format: string
  width: number
  height: number
  bytes: number
}
export interface GenerationData {
  requestId: string
  provider: string
  requestedModel: string
  reportedModel?: string
  requestedCount: number
  returnedCount: number
  parameters: Parameters
  endpoint: string
  capabilityEvidence: { known: ModelCapability | null; provider: ModelCapability | null }
  images: SavedImage[]
  failures: { index: number; error: ErrorInfo }[]
  recordPath: string | null
  submissionStatus: 'not_submitted' | 'submitted' | 'result_received' | 'unknown'
  usage?: unknown
}
export interface GenerationOutcome {
  status: 'success' | 'partial_success' | 'error' | 'unknown' | 'interrupted'
  exitCode: number
  data: GenerationData
  error?: ErrorInfo
}

function base64Bytes(value: string): Buffer {
  const encoded = value.replace(/^data:image\/[^;,]+;base64,/, '').replace(/\s/g, '')
  if (
    encoded.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) ||
    encoded.length % 4 === 1
  ) {
    throw new ImgRelayError('image_decode_error', 'Base64 图片无效或超过 32 MiB 限制', 3)
  }
  const bytes = Buffer.from(encoded, 'base64')
  if (
    bytes.length > MAX_IMAGE_BYTES ||
    bytes.toString('base64').replace(/=+$/, '') !== encoded.replace(/=+$/, '')
  ) {
    throw new ImgRelayError('image_decode_error', 'Base64 图片解码失败', 3)
  }
  return bytes
}

async function download(urlString: string, signal?: AbortSignal): Promise<Buffer> {
  let current = urlString
  try {
    for (let redirects = 0; redirects <= 3; redirects++) {
      const url = new URL(current)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new ImgRelayError(
          'image_download_error',
          '图片地址必须为不含内嵌凭据的 HTTP(S) URL',
          3,
        )
      const timeout = AbortSignal.timeout(60_000)
      const response = await fetch(url, {
        redirect: 'manual',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (!location) throw new ImgRelayError('image_download_error', '图片重定向缺少目标地址', 3)
        current = new URL(location, url).toString()
        continue
      }
      if (!response.ok) {
        await response.body?.cancel()
        throw new ImgRelayError(
          'image_download_error',
          `图片下载返回 HTTP ${response.status}`,
          3,
          response.status,
        )
      }
      return await readBounded(response, MAX_IMAGE_BYTES)
    }
    throw new ImgRelayError('image_download_error', '图片下载重定向超过三次', 3)
  } catch (error) {
    if (signal?.aborted)
      throw new ImgRelayError('interrupted', '已停止本地保存；无法保证取消已提交的上游生成', 130)
    if (error instanceof ImgRelayError) throw error
    throw new ImgRelayError('image_download_error', '图片下载超时或网络失败；不会重新生成图片', 3)
  }
}

function usageNumbers(value: unknown, depth = 0): unknown {
  if (depth > 4) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const entries = Object.entries(value)
    .slice(0, 100)
    .flatMap(([key, item]) => {
      if (!/^[a-z_][a-z0-9_]{0,63}$/i.test(key)) return []
      const result = usageNumbers(item, depth + 1)
      return result === undefined ? [] : [[key, result]]
    })
  return entries.length ? Object.fromEntries(entries) : undefined
}

export async function generate(store: Store, options: GenerateOptions): Promise<GenerationOutcome> {
  if (!options.prompt.trim()) throw new ImgRelayError('input_error', '提示词不能为空')
  if (
    options.timeoutSeconds !== undefined &&
    (!Number.isFinite(options.timeoutSeconds) ||
      options.timeoutSeconds <= 0 ||
      options.timeoutSeconds > 2_147_483)
  )
    throw new ImgRelayError('input_error', '超时必须是有效的正数秒数')
  if (
    options.filename &&
    (basename(options.filename) !== options.filename ||
      /[<>:"/\\|?*]/.test(options.filename) ||
      options.filename.split('').some((character) => character.charCodeAt(0) < 32) ||
      !parse(options.filename).name ||
      ['.', '..'].includes(options.filename))
  )
    throw new ImgRelayError('input_error', '--filename 必须是普通文件名，保存目录使用 --output-dir')
  const selected = await store.selected(options.provider)
  const model = (options.model || selected.provider.defaultModel || '').trim()
  if (!model)
    throw new ImgRelayError(
      'config_error',
      '未配置默认模型，请通过 --model 指定或运行 provider edit',
    )
  const key = await store.key(selected.provider)
  const outputDir = resolve(options.outputDir || 'output/imagegen')
  const requestId = randomUUID()
  const recordPath = join(outputDir, `${requestId}-report.json`)
  const supplied: Parameters = {}
  for (const name of ['size', 'n', 'quality', 'outputFormat', 'responseFormat'] as const) {
    const value = options[name]
    if (value !== undefined) Object.assign(supplied, { [name]: value })
  }
  const data: GenerationData = {
    requestId,
    provider: selected.name,
    requestedModel: model,
    requestedCount: supplied.n || selected.provider.defaults.n || 1,
    returnedCount: 0,
    parameters: { ...selected.provider.defaults, ...supplied },
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
    images: [],
    failures: [],
    recordPath,
    submissionStatus: 'not_submitted',
  }
  const record = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    prompt: options.prompt,
    ...data,
  }
  try {
    await mkdir(outputDir, { recursive: true })
    if (options.filename && !options.overwrite) {
      try {
        await access(join(outputDir, options.filename))
        throw new ImgRelayError(
          'save_error',
          '目标文件已存在，请使用其他文件名或显式 --overwrite',
          4,
        )
      } catch (error) {
        if (!isNotFound(error)) throw error
      }
    }
    await writeFile(
      recordPath,
      `${JSON.stringify(store.redactor.value({ ...record, status: 'prepared' }), null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    )
  } catch (error) {
    if (error instanceof ImgRelayError) throw error
    throw new ImgRelayError('save_error', '无法创建输出目录或请求记录；未提交生成请求', 4)
  }
  let outcome: GenerationOutcome
  try {
    data.parameters = resolveParameters(selected.provider, model, supplied)
    const body: Record<string, unknown> = { model, prompt: options.prompt }
    for (const [name, value] of Object.entries(data.parameters)) {
      const wire =
        { outputFormat: 'output_format', responseFormat: 'response_format' }[name] || name
      body[wire] = value
    }
    if (options.signal?.aborted)
      throw new ImgRelayError('interrupted', '用户中断，未提交生成请求', 130)
    options.progress?.('正在等待生图接口，生成请求只提交一次…')
    data.submissionStatus = 'submitted'
    const response = await requestJson({
      url: data.endpoint,
      key,
      redactor: store.redactor,
      method: 'POST',
      body,
      timeoutSeconds: options.timeoutSeconds || selected.provider.timeoutSeconds,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    data.submissionStatus = 'result_received'
    if (
      !response ||
      typeof response !== 'object' ||
      !('data' in response) ||
      !Array.isArray(response.data) ||
      response.data.length === 0
    )
      throw new ImgRelayError('invalid_response', '上游响应没有有效的 data[] 图片结果', 3)
    if ('model' in response && typeof response.model === 'string')
      data.reportedModel = response.model
    if ('usage' in response) {
      const usage = usageNumbers(response.usage)
      if (usage !== undefined) data.usage = usage
    }
    data.returnedCount = response.data.length
    for (const [offset, item] of response.data.entries()) {
      const index = offset + 1
      try {
        if (options.signal?.aborted)
          throw new ImgRelayError('interrupted', '用户中断保存，已保存的文件保持不变', 130)
        if (!item || typeof item !== 'object')
          throw new ImgRelayError('invalid_response', '图片条目不是对象', 3)
        let bytes: Buffer
        if ('b64_json' in item && typeof item.b64_json === 'string' && item.b64_json)
          bytes = base64Bytes(item.b64_json)
        else if ('url' in item && typeof item.url === 'string' && item.url)
          bytes = await download(item.url, options.signal)
        else throw new ImgRelayError('invalid_response', '图片条目缺少 b64_json 或 url', 3)
        let dimensions: ReturnType<typeof imageSize>
        let format: Awaited<ReturnType<typeof fileTypeFromBuffer>>
        try {
          format = await fileTypeFromBuffer(bytes)
          dimensions = imageSize(bytes)
          if (!format?.mime.startsWith('image/') || !dimensions.width || !dimensions.height)
            throw new Error('Invalid image')
        } catch {
          throw new ImgRelayError('image_decode_error', '返回数据不是可识别的有效图片', 3)
        }
        const stem = options.filename ? parse(options.filename).name : requestId
        const sequence =
          !options.filename || response.data.length > 1 ? `-${String(index).padStart(2, '0')}` : ''
        const path = join(outputDir, `${stem}${sequence}.${format.ext}`)
        const handle = await open(path, options.overwrite ? 'w' : 'wx', 0o600).catch(() => {
          throw new ImgRelayError('save_error', '无法保存图片；请检查文件重名和目录权限', 4)
        })
        try {
          await handle.writeFile(bytes)
          await handle.sync()
        } catch {
          await handle.close().catch(() => {})
          await unlink(path).catch(() => {})
          throw new ImgRelayError('save_error', '图片写入失败；不会重新提交生成', 4)
        } finally {
          await handle.close().catch(() => {})
        }
        data.images.push({
          index,
          path,
          format: format.ext,
          width: dimensions.width,
          height: dimensions.height,
          bytes: bytes.length,
        })
        options.progress?.(`已保存 ${index}/${data.returnedCount} 张图片`)
      } catch (error) {
        data.failures.push({ index, error: store.redactor.error(error) })
        if (error instanceof ImgRelayError && error.category === 'interrupted') throw error
      }
    }
    const failed = data.failures.length > 0
    const error = data.failures[0]?.error
    outcome = data.images.length
      ? { status: failed ? 'partial_success' : 'success', exitCode: failed ? 5 : 0, data }
      : {
          status: 'error',
          exitCode: data.failures.some((failure) => failure.error.category === 'save_error')
            ? 4
            : 3,
          data,
          ...(error ? { error } : {}),
        }
  } catch (error) {
    const info = store.redactor.error(error)
    if (info.category === 'result_unknown') data.submissionStatus = 'unknown'
    outcome = {
      status:
        info.category === 'result_unknown'
          ? 'unknown'
          : info.category === 'interrupted'
            ? 'interrupted'
            : 'error',
      exitCode: error instanceof ImgRelayError ? error.exitCode : 1,
      data,
      error: info,
    }
  }
  try {
    await writeAtomic(
      recordPath,
      store.redactor.value({
        ...record,
        ...data,
        status: outcome.status,
        error: outcome.error || null,
        completedAt: new Date().toISOString(),
      }),
    )
  } catch {
    data.recordPath = null
    return {
      status: 'error',
      exitCode: 4,
      data,
      error: {
        category: 'save_error',
        message: '生成记录保存失败；已保存的图片路径仍可使用，不会重新生成',
      },
    }
  }
  return outcome
}
