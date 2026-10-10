/* Response streaming and bounded retries are deliberately sequential. */
/* eslint-disable no-await-in-loop */
import { setTimeout as delay } from 'node:timers/promises'

import { ImgRelayError } from './errors.js'
import type { Redactor } from './errors.js'

export const MAX_JSON_BYTES = 128 * 1024 * 1024
export const MAX_IMAGE_BYTES = 32 * 1024 * 1024

export async function readBounded(response: Response, limit: number): Promise<Buffer> {
  if (Number(response.headers.get('content-length')) > limit) {
    await response.body?.cancel()
    throw new ImgRelayError('invalid_response', '上游响应超过大小限制', 3)
  }
  if (!response.body) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new ImgRelayError('invalid_response', '上游响应超过大小限制', 3)
      chunks.push(value)
    }
    return Buffer.concat(chunks, size)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function httpError(status: number, text: string, redactor: Redactor): ImgRelayError {
  let detail = ''
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && 'error' in parsed) {
      const error = parsed.error
      if (typeof error === 'string') detail = error
      else if (
        error &&
        typeof error === 'object' &&
        'message' in error &&
        typeof error.message === 'string'
      )
        detail = error.message
    }
  } catch {
    /* HTML and other raw response bodies are not diagnostic output. */
  }
  let category:
    | 'auth_error'
    | 'rate_limit'
    | 'quota_exceeded'
    | 'upstream_error'
    | 'model_unavailable'
    | 'parameter_unsupported' = 'upstream_error'
  if (status === 401 || status === 403) category = 'auth_error'
  else if (status === 429) category = 'rate_limit'
  else if (status === 402 || /insufficient.*(quota|balance)|余额不足/i.test(detail))
    category = 'quota_exceeded'
  else if (/model.*(not found|not exist|unavailable|invalid)|模型.*(不存在|不可用)/i.test(detail))
    category = 'model_unavailable'
  else if (
    /unsupported.*(param|size|quality|format)|unknown parameter|参数.*(不支持|无效)/i.test(detail)
  )
    category = 'parameter_unsupported'
  return new ImgRelayError(
    category,
    redactor.text(
      `上游返回 HTTP ${status}${detail ? `：${detail.slice(0, 1000)}` : '，请检查接口、权限和请求参数'}`,
    ),
    3,
    status,
  )
}

export async function requestJson(options: {
  url: string
  key: string
  redactor: Redactor
  method?: 'GET' | 'POST'
  body?: unknown
  timeoutSeconds?: number
  signal?: AbortSignal
  retry?: boolean
}): Promise<unknown> {
  const method = options.method || 'GET'
  const attempts = method === 'GET' && options.retry ? 2 : 1
  for (let attempt = 0; attempt < attempts; attempt++) {
    const timeout = AbortSignal.timeout(Math.ceil((options.timeoutSeconds || 15) * 1000))
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout
    try {
      const response = await fetch(options.url, {
        method,
        headers: {
          Authorization: `Bearer ${options.key}`,
          ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        redirect: 'manual',
        signal,
      })
      const text = (await readBounded(response, response.ok ? MAX_JSON_BYTES : 64 * 1024)).toString(
        'utf8',
      )
      if (!response.ok) throw httpError(response.status, text, options.redactor)
      try {
        return JSON.parse(text) as unknown
      } catch {
        throw new ImgRelayError('invalid_response', '上游成功响应不是有效 JSON', 3)
      }
    } catch (error) {
      if (options.signal?.aborted)
        throw new ImgRelayError(
          'interrupted',
          method === 'POST' ? '已停止本地等待，无法保证取消已提交的上游生成' : '用户中断请求',
          130,
        )
      const retryable =
        !(error instanceof ImgRelayError) ||
        error.httpStatus === 429 ||
        (error.httpStatus !== undefined && error.httpStatus >= 500)
      if (attempt + 1 < attempts && retryable) {
        await delay(150)
        continue
      }
      if (error instanceof ImgRelayError) throw error
      throw new ImgRelayError(
        method === 'POST' ? 'result_unknown' : 'upstream_error',
        method === 'POST'
          ? '生成请求超时或网络断开，结果未知；上游可能仍在生成，请勿直接重复提交'
          : '模型查询超时或网络失败，请检查地址和网络',
        3,
      )
    }
  }
  throw new ImgRelayError('internal_error', '请求执行状态无效', 1)
}
