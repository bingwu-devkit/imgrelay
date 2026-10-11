import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, unlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

import {
  defaultConfigDirectory,
  doctor,
  generate,
  models,
  normalizeBaseUrl,
  parseProvider,
  resolveEndpoint,
  Store,
} from '../src/index.js'

const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJf8AAAAASUVORK5CYII=',
  'base64',
)
const TEST_KEY = 'relay-test-key-without-a-vendor-prefix'
interface SeenRequest {
  method: string
  path: string
  authorization: string | undefined
  body: Record<string, unknown>
}
let directory: string
let store: Store
let url: string
let seen: SeenRequest[]
let handler: (
  request: IncomingMessage,
  response: ServerResponse,
  body: Record<string, unknown>,
) => void | Promise<void>
let server: ReturnType<typeof createServer>

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function add(name = 'relay', overrides: Record<string, unknown> = {}): Promise<void> {
  await store.put(
    name,
    {
      protocol: 'openai-images',
      baseUrl: `${url}/v1`,
      apiKey: TEST_KEY,
      defaultModel: 'vendor-custom-model',
      ...overrides,
    },
    { makeDefault: true },
  )
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'imgrelay-core-'))
  store = new Store(join(directory, 'config'))
  seen = []
  handler = (_request, response, _body) =>
    json(response, { data: [{ b64_json: PNG.toString('base64') }] })
  server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const text = Buffer.concat(chunks).toString()
      const body = text ? z.record(z.string(), z.unknown()).parse(JSON.parse(text)) : {}
      seen.push({
        method: request.method || '',
        path: request.url || '',
        authorization: request.headers.authorization,
        body,
      })
      await handler(request, response, body)
    })().catch(() => {
      if (!response.headersSent)
        json(response, { error: { message: 'fixture handler failed' } }, 500)
    })
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fixture address missing')
  url = `http://127.0.0.1:${address.port}`
}, 60_000)

afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
  vi.unstubAllEnvs()
  if (!resolve(directory).startsWith(join(tmpdir(), 'imgrelay-core-')))
    throw new Error('Unsafe test cleanup path')
  await rm(directory, { recursive: true, force: true })
})

describe('供应商与凭据', () => {
  it('默认目录统一为 ~/.imgrelay，支持环境变量覆盖相对目录', () => {
    vi.stubEnv('IMGRELAY_CONFIG_DIR', '')
    vi.stubEnv('APPDATA', join(directory, 'appdata'))
    vi.stubEnv('XDG_CONFIG_HOME', join(directory, 'xdg'))
    expect(defaultConfigDirectory()).toBe(join(homedir(), '.imgrelay'))
    vi.stubEnv('IMGRELAY_CONFIG_DIR', 'custom-imgrelay-config')
    expect(defaultConfigDirectory()).toBe(resolve('custom-imgrelay-config'))
  })

  it('输入密钥明文保存到配置，新实例可读取且删除供应商一并清理', async () => {
    await store.put(
      'managed',
      { protocol: 'openai-images', baseUrl: url },
      { secret: TEST_KEY, makeDefault: true },
    )
    const selected = await new Store(store.directory).selected()
    expect(await store.key(selected.provider)).toBe(TEST_KEY)
    expect(selected.provider).toMatchObject({ apiKey: TEST_KEY })
    expect(await readFile(join(store.directory, 'config.json'), 'utf8')).toContain(TEST_KEY)
    expect(await readdir(store.directory)).toEqual(['config.json'])
    await store.remove('managed')
    expect((await store.config()).defaultProvider).toBeUndefined()
    expect(await readFile(join(store.directory, 'config.json'), 'utf8')).not.toContain(TEST_KEY)
  }, 60_000)

  it('并发添加供应商不会丢失配置，单次选择不改变默认项', async () => {
    await Promise.all(
      ['alpha', 'beta'].map((name) =>
        new Store(store.directory).put(name, { protocol: 'openai-images', baseUrl: url }),
      ),
    )
    expect(Object.keys((await store.config()).providers).toSorted()).toEqual(['alpha', 'beta'])
    await store.use('alpha')
    expect((await store.selected('beta')).name).toBe('beta')
    expect((await store.selected()).name).toBe('alpha')
  }, 60_000)

  it('普通目录中的手动配置可读取，API Key 在新实例输出中脱敏', async () => {
    await mkdir(store.directory, { recursive: true })
    const path = join(store.directory, 'config.json')
    await writeFile(
      path,
      JSON.stringify({
        schemaVersion: 1,
        defaultProvider: 'manual',
        providers: { manual: { protocol: 'openai-images', baseUrl: url, apiKey: TEST_KEY } },
      }),
    )
    if (process.platform !== 'win32') {
      await chmod(store.directory, 0o755)
      await chmod(path, 0o644)
    }
    const fresh = new Store(store.directory)
    const selected = await fresh.selected()
    expect(await fresh.key(selected.provider)).toBe(TEST_KEY)
    expect(JSON.stringify(fresh.redactor.value(selected))).not.toContain(TEST_KEY)
  })

  it('拒绝无效协议、外部凭据引用和不合法密钥', () => {
    expect(() => parseProvider({ protocol: 'unknown', baseUrl: url })).toThrow('供应商配置无效')
    expect(() =>
      parseProvider({
        protocol: 'openai-images',
        baseUrl: url,
        apiKey: TEST_KEY,
        credentialRef: { type: 'env', name: 'IMGRELAY_TEST_KEY' },
      }),
    ).toThrow('供应商配置无效')
    expect(() =>
      parseProvider({
        protocol: 'openai-images',
        baseUrl: url,
        credentialRef: { type: 'file', path: 'key.txt' },
      }),
    ).toThrow('供应商配置无效')
    for (const apiKey of ['', '   ', 'key\nother', 'key\0other']) {
      expect(() => parseProvider({ protocol: 'openai-images', baseUrl: url, apiKey })).toThrow(
        '供应商配置无效',
      )
    }
  })
})

describe('模型发现与兼容', () => {
  it('正确解析不同基础地址，避免重复 v1 与丢失前缀', () => {
    expect(resolveEndpoint(normalizeBaseUrl(`${url}/v1/`), '/v1/models')).toBe(`${url}/v1/models`)
    expect(
      resolveEndpoint(
        normalizeBaseUrl(`${url}/proxy/v1/images/generations`),
        '/v1/images/generations',
      ),
    ).toBe(`${url}/proxy/v1/images/generations`)
    expect(resolveEndpoint(normalizeBaseUrl(url), '/v1/models')).toBe(`${url}/v1/models`)
    expect(() => resolveEndpoint(url, 'https://other.example/images')).toThrow('端点必须是路径')
    expect(() => resolveEndpoint(url, '/%2e%2e/key')).toThrow('端点必须是路径')
    const full = parseProvider({
      protocol: 'openai-images',
      baseUrl: `${url}/proxy/images/generations/`,
    })
    expect(resolveEndpoint(full.baseUrl, full.endpoints.generate || '/v1/images/generations')).toBe(
      `${url}/proxy/images/generations`,
    )
    expect(resolveEndpoint(full.baseUrl, '/v1/models')).toBe(`${url}/proxy/v1/models`)
  })

  it('保留原始模型 ID，复用缓存且凭据、地址变化后失效', async () => {
    await add()
    handler = (_request, response) =>
      json(response, { data: [{ id: 'strange/model:custom' }, { id: 'text-model', type: 'text' }] })
    const first = await models(store)
    expect(first.models[0]?.id).toBe('strange/model:custom')
    expect((await models(store)).cached).toBe(true)
    expect(seen).toHaveLength(1)
    const original = await store.selected()
    await store.put('relay', { ...original.provider, apiKey: 'a-different-key' }, { edit: true })
    expect((await models(store)).cached).toBe(false)
    expect(seen[1]?.authorization).toBe('Bearer a-different-key')
    const selected = await store.selected()
    await store.put('relay', { ...selected.provider, baseUrl: `${url}/proxy/v1` }, { edit: true })
    await models(store)
    expect(seen.at(-1)?.path).toBe('/proxy/v1/models')
    expect(await readFile(join(store.directory, 'models-cache.json'), 'utf8')).not.toContain(
      TEST_KEY,
    )
    expect((await readdir(store.directory)).toSorted()).toEqual([
      'config.json',
      'models-cache.json',
    ])
  }, 60_000)

  it('手动修改 config.json 中的 API Key 也会使模型缓存失效', async () => {
    await store.put(
      'inline',
      {
        protocol: 'openai-images',
        baseUrl: url,
        apiKey: TEST_KEY,
      },
      { makeDefault: true },
    )
    handler = (_request, response) => json(response, { data: [{ id: 'manual' }] })
    expect((await models(store)).cached).toBe(false)
    expect((await models(new Store(store.directory))).cached).toBe(true)
    const config = await store.config()
    const provider = config.providers.inline
    if (!provider) throw new Error('Missing provider')
    provider.apiKey = 'manually-updated-key'
    await writeFile(join(store.directory, 'config.json'), JSON.stringify(config))
    expect((await models(new Store(store.directory))).cached).toBe(false)
    expect(seen.at(-1)?.authorization).toBe('Bearer manually-updated-key')
    const cache = await readFile(join(store.directory, 'models-cache.json'), 'utf8')
    expect(cache).not.toContain(TEST_KEY)
    expect(cache).not.toContain(provider.apiKey)
  })

  it('缺少模型接口不阻断手动模型，doctor 不提交生成', async () => {
    await add()
    handler = (request, response) =>
      request.method === 'GET'
        ? json(response, {}, 404)
        : json(response, { data: [{ b64_json: PNG.toString('base64') }] })
    const checked = await doctor(store)
    expect(checked.exitCode).toBe(3)
    expect(seen.every((request) => request.method === 'GET')).toBe(true)
    const generated = await generate(store, {
      prompt: 'keep exactly',
      model: 'not-in-any-list',
      outputDir: join(directory, 'images'),
    })
    expect(generated.exitCode).toBe(0)
    expect(seen.at(-1)?.body.model).toBe('not-in-any-list')
  }, 60_000)

  it('只读请求有限重试，生成 POST 的 5xx 不重试', async () => {
    await add()
    let reads = 0
    handler = (request, response) => {
      if (request.method === 'GET' && ++reads === 2) json(response, { data: [{ id: 'model' }] })
      else json(response, { error: { message: 'temporary error' } }, 503)
    }
    expect((await models(store)).models).toHaveLength(1)
    const generated = await generate(store, {
      prompt: 'test',
      outputDir: join(directory, 'images'),
    })
    expect(generated.exitCode).toBe(3)
    expect(seen.filter((request) => request.method === 'POST')).toHaveLength(1)
  }, 60_000)
})

describe('生成与恢复规则', () => {
  it('原始提示词摘要不因恰好含有配置密钥片段而被脱敏改写', async () => {
    const prompt = '保持请求摘要一致\n中文 😀\n'
    const digest = createHash('sha256').update(prompt).digest('hex')
    await add('relay', { apiKey: digest.slice(0, 16) })
    const result = await generate(store, { prompt, outputDir: join(directory, 'images') })
    expect(result.exitCode).toBe(0)
    expect(store.redactor.value(result.data)).toMatchObject({ promptSha256: digest })
    if (!result.data.recordPath) throw new Error('Missing generation record')
    expect(JSON.parse(await readFile(result.data.recordPath, 'utf8')) as unknown).toMatchObject({
      promptSha256: digest,
    })
    expect(seen[0]?.body.prompt).toBe(prompt)
  })

  it('混合多图保留成功项，Base64 优先，跨域及重定向下载不带 Key', async () => {
    await add('relay', { defaults: { quality: 'low', outputFormat: 'jpeg' } })
    const downloadAuth: (string | undefined)[] = []
    const downloader = createServer((request, response) => {
      downloadAuth.push(request.headers.authorization)
      response.writeHead(200, { 'Content-Type': 'image/png' })
      response.end(PNG)
    })
    await new Promise<void>((ready) => downloader.listen(0, '127.0.0.1', ready))
    const address = downloader.address()
    if (!address || typeof address === 'string') throw new Error('No download address')
    handler = (request, response) => {
      if (request.method === 'POST')
        json(response, {
          data: [
            { b64_json: PNG.toString('base64'), url: `${url}/never-download?token=secret` },
            { b64_json: 'broken!' },
            { url: `${url}/redirect?token=signed` },
          ],
          usage: { input_tokens: 9 },
          model: 'reported-model',
        })
      else {
        response.writeHead(302, { Location: `http://127.0.0.1:${address.port}/image` })
        response.end()
      }
    }
    try {
      const result = await generate(store, {
        prompt: '原样\n保持 $() 和引号 "',
        n: 3,
        quality: 'ultra',
        outputDir: join(directory, 'images'),
      })
      expect(result.exitCode).toBe(5)
      expect(result.data.images).toHaveLength(2)
      expect(result.data.failures[0]?.error.category).toBe('image_decode_error')
      expect(downloadAuth).toEqual([undefined])
      expect(seen.filter((request) => request.method === 'POST')).toHaveLength(1)
      expect(seen.find((request) => request.method === 'POST')?.body).toMatchObject({
        n: 3,
        quality: 'ultra',
        output_format: 'jpeg',
        prompt: '原样\n保持 $() 和引号 "',
      })
      expect((await store.selected()).provider.defaults.quality).toBe('low')
      const image = result.data.images[0]
      if (!image || !result.data.recordPath) throw new Error('Missing results')
      expect(image).toMatchObject({ format: 'png', width: 1, height: 1, bytes: PNG.length })
      expect(await readFile(image.path)).toEqual(PNG)
      const record = await readFile(result.data.recordPath, 'utf8')
      expect(record).not.toContain('token=')
      expect(record).not.toContain(PNG.toString('base64'))
      expect(record).not.toContain(TEST_KEY)
    } finally {
      downloader.closeAllConnections()
      await new Promise<void>((done) => downloader.close(() => done()))
    }
  }, 60_000)

  it('能力覆盖对显式参数也生效，拒绝时记录请求且不拆单', async () => {
    await add('relay', {
      modelOverrides: {
        'vendor-custom-model': { source: 'provider_override', parameters: { n: { max: 1 } } },
      },
    })
    const result = await generate(store, {
      prompt: 'test',
      n: 2,
      outputDir: join(directory, 'images'),
    })
    expect(result.exitCode).toBe(2)
    expect(result.error?.category).toBe('parameter_unsupported')
    expect(seen).toHaveLength(0)
    expect(result.data.recordPath).not.toBeNull()
  }, 60_000)

  it('已知 GPT Image 不发送 response_format，默认文件名唯一', async () => {
    await add('relay', { defaultModel: 'gpt-image-1' })
    const first = await generate(store, { prompt: 'test', outputDir: join(directory, 'images') })
    const second = await generate(store, { prompt: 'test', outputDir: join(directory, 'images') })
    expect(first.exitCode).toBe(0)
    expect(first.data.images[0]?.path).not.toBe(second.data.images[0]?.path)
    expect(seen[0]?.body).toEqual({ model: 'gpt-image-1', prompt: 'test', n: 1 })
    expect(first.data.capabilityEvidence.known).toMatchObject({
      source: 'official_documentation',
      verifiedAt: expect.any(String),
    })
    expect(second.data.endpoint).toBe(`${url}/v1/images/generations`)
  }, 60_000)

  it('请求超时标记结果未知，只提交一次', async () => {
    await add()
    handler = (_request, response) =>
      new Promise<void>((done) => {
        setTimeout(() => {
          json(response, { data: [{ b64_json: PNG.toString('base64') }] })
          done()
        }, 300)
      })
    const result = await generate(store, {
      prompt: 'test',
      timeoutSeconds: 0.05,
      outputDir: join(directory, 'images'),
    })
    expect(result.status).toBe('unknown')
    expect(result.data.submissionStatus).toBe('unknown')
    expect(seen.filter((request) => request.method === 'POST')).toHaveLength(1)
  }, 60_000)

  it('用户中断返回 130 并保留记录，不追加生成', async () => {
    await add()
    const controller = new AbortController()
    handler = () => {
      controller.abort()
    }
    const result = await generate(store, {
      prompt: 'test',
      signal: controller.signal,
      outputDir: join(directory, 'images'),
    })
    expect(result.exitCode).toBe(130)
    expect(result.error?.category).toBe('interrupted')
    expect(seen).toHaveLength(1)
  }, 60_000)

  it('输出目录不可写时不提交，文件重名不覆盖已有图片', async () => {
    await add()
    const path = join(directory, 'not-a-directory')
    await writeFile(path, 'original')
    await expect(generate(store, { prompt: 'test', outputDir: path })).rejects.toMatchObject({
      category: 'save_error',
    })
    expect(seen).toHaveLength(0)
    const first = await generate(store, {
      prompt: 'test',
      filename: 'named.png',
      outputDir: join(directory, 'images'),
    })
    await expect(
      generate(store, {
        prompt: 'test',
        filename: 'named.png',
        outputDir: join(directory, 'images'),
      }),
    ).rejects.toMatchObject({ category: 'save_error' })
    expect(seen).toHaveLength(1)
    expect(await readFile(first.data.images[0]?.path || '')).toEqual(PNG)
  }, 60_000)

  it('图片成功但记录保存失败时返回文件路径，不重新生成', async () => {
    await add()
    const outputDir = join(directory, 'images')
    handler = async (_request, response) => {
      const record = (await readdir(outputDir)).find((name) => name.endsWith('-report.json'))
      if (!record) throw new Error('Missing prepared record')
      await unlink(join(outputDir, record))
      await mkdir(join(outputDir, record))
      json(response, { data: [{ b64_json: PNG.toString('base64') }] })
    }
    const result = await generate(store, { prompt: 'test', outputDir })
    expect(result.exitCode).toBe(4)
    expect(result.data.images).toHaveLength(1)
    expect(result.data.recordPath).toBeNull()
    expect(seen).toHaveLength(1)
  }, 60_000)

  it('上游回显密钥和签名链接时错误与记录脱敏', async () => {
    await add()
    handler = (_request, response) =>
      json(response, { error: { message: `${TEST_KEY} https://example.com/img?key=secret` } }, 401)
    const result = await generate(store, { prompt: 'test', outputDir: join(directory, 'images') })
    expect(result.error?.category).toBe('auth_error')
    expect(JSON.stringify(result)).not.toContain(TEST_KEY)
    expect(JSON.stringify(result)).not.toContain('key=secret')
    expect(await readFile(result.data.recordPath || '', 'utf8')).not.toContain(TEST_KEY)
  }, 60_000)

  it('提示词中的换行、引号和首尾空白在请求与记录中原样保留', async () => {
    await add()
    const prompt = '  第一行\n第二行 " ${value} `text`\n'
    const result = await generate(store, { prompt, outputDir: join(directory, 'images') })
    expect(result.exitCode).toBe(0)
    expect(seen[0]?.body.prompt).toBe(prompt)
    expect(JSON.parse(await readFile(result.data.recordPath || '', 'utf8'))).toMatchObject({
      prompt,
    })
  })

  it.each(['', ' ', '\r\n\t'])('拒绝空白提示词 %j，不提交请求或写入记录', async (prompt) => {
    const outputDir = join(directory, 'images')
    await expect(generate(store, { prompt, outputDir })).rejects.toMatchObject({
      category: 'input_error',
      exitCode: 2,
    })
    expect(seen).toHaveLength(0)
    await expect(readdir(outputDir)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
