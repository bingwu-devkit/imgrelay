import { ImgRelayError } from './errors.js'

export function parseApiUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new ImgRelayError('config_error', 'API 地址必须是完整的 HTTP 或 HTTPS URL')
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new ImgRelayError(
      'config_error',
      'API 地址只能使用 HTTP(S)，不能包含凭据、查询参数或片段',
    )
  }
  return url
}

export function normalizeBaseUrl(value: string): string {
  return normalizeAddress(value).baseUrl
}

export function normalizeAddress(value: string): { baseUrl: string; generationPath?: string } {
  const url = parseApiUrl(value)
  const path = url.pathname.replace(/\/+$/, '')
  const isGeneration = path.endsWith('/images/generations')
  url.pathname = isGeneration ? path.slice(0, -'/images/generations'.length) : path
  return {
    baseUrl: url.toString().replace(/\/+$/, ''),
    ...(isGeneration ? { generationPath: '/images/generations' } : {}),
  }
}

export function validateEndpoint(path: string): boolean {
  try {
    return (
      path.startsWith('/') &&
      !/[?#\\]/.test(path) &&
      !path.includes('//') &&
      !path.split('/').some((part) => ['..', '.'].includes(decodeURIComponent(part)))
    )
  } catch {
    return false
  }
}

export function resolveEndpoint(baseUrl: string, endpoint: string): string {
  if (!validateEndpoint(endpoint)) {
    throw new ImgRelayError('config_error', '端点必须是路径，不能包含主机、查询参数或上级目录')
  }
  const url = parseApiUrl(baseUrl)
  const basePath = url.pathname.replace(/\/+$/, '')
  const suffix =
    basePath.endsWith('/v1') && endpoint.startsWith('/v1/') ? endpoint.slice(3) : endpoint
  url.pathname = `${basePath}${suffix}`
  return url.toString()
}
