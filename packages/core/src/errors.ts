export type ErrorCategory =
  | 'input_error'
  | 'config_error'
  | 'credential_error'
  | 'config_busy'
  | 'auth_error'
  | 'model_unavailable'
  | 'parameter_unsupported'
  | 'rate_limit'
  | 'quota_exceeded'
  | 'upstream_error'
  | 'invalid_response'
  | 'image_decode_error'
  | 'image_download_error'
  | 'result_unknown'
  | 'save_error'
  | 'interrupted'
  | 'internal_error'

export interface ErrorInfo {
  category: ErrorCategory
  message: string
  httpStatus?: number
}

export class ImgRelayError extends Error {
  readonly category: ErrorCategory
  readonly exitCode: number
  readonly httpStatus: number | undefined

  constructor(category: ErrorCategory, message: string, exitCode = 2, httpStatus?: number) {
    super(message)
    this.name = 'ImgRelayError'
    this.category = category
    this.exitCode = exitCode
    this.httpStatus = httpStatus
  }
}

/** Redact before serialization; never retain an upstream response as a diagnostic. */
export class Redactor {
  private readonly secrets = new Set<string>()

  add(secret: string): void {
    if (secret) this.secrets.add(secret)
  }

  text(value: string): string {
    let text = value
    for (const secret of [...this.secrets].toSorted((a, b) => b.length - a.length)) {
      text = text.replaceAll(secret, '[REDACTED]')
    }
    return text.replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw)
        if (url.username || url.password) {
          url.username = 'REDACTED'
          url.password = ''
        }
        if (url.search) url.search = '?REDACTED'
        if (url.hash) url.hash = '#REDACTED'
        return url.toString()
      } catch {
        return '[REDACTED_URL]'
      }
    })
  }

  value(value: unknown): unknown {
    if (typeof value === 'string') return this.text(value)
    if (Array.isArray(value)) return value.map((item) => this.value(item))
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [
          this.text(key),
          // Locally computed integrity hashes must remain comparable to the caller's digest.
          key === 'promptSha256' && typeof item === 'string' && /^[a-f0-9]{64}$/.test(item)
            ? item
            : this.value(item),
        ]),
      )
    }
    return value
  }

  error(error: unknown): ErrorInfo {
    if (error instanceof ImgRelayError) {
      return {
        category: error.category,
        message: this.text(error.message),
        ...(error.httpStatus === undefined ? {} : { httpStatus: error.httpStatus }),
      }
    }
    return {
      category: 'internal_error',
      message: this.text(error instanceof Error ? error.message : '发生未知错误'),
    }
  }
}
