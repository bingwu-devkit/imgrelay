import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { Store } from '@imgrelay/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'

import packageJson from '../package.json' with { type: 'json' }

const entry = resolve(import.meta.dirname, '../dist/index.mjs')
const KEY = 'cli-fixture-secret-without-sk-prefix'
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJf8AAAAASUVORK5CYII='
let directory: string
let url: string
let server: ReturnType<typeof createServer>
let requests: {
  method: string
  path: string
  body: Record<string, unknown>
  authorization: string | undefined
}[]
let rejectAuth = false
let handler: ((request: IncomingMessage, response: ServerResponse) => void) | undefined

const envelopeSchema = z.strictObject({
  schemaVersion: z.literal(1),
  command: z.string(),
  status: z.enum(['success', 'partial_success', 'error', 'unknown', 'interrupted']),
  data: z
    .object({
      providers: z.array(z.unknown()).optional(),
      cached: z.boolean().optional(),
      models: z.array(z.object({ id: z.string() })).optional(),
      images: z
        .array(
          z.object({
            path: z.string(),
            width: z.number(),
            height: z.number(),
            bytes: z.number(),
            format: z.string(),
          }),
        )
        .optional(),
      failures: z
        .array(z.object({ index: z.number(), error: z.object({ category: z.string() }) }))
        .optional(),
      recordPath: z.string().nullable().optional(),
      requestedModel: z.string().optional(),
      provider: z.string().optional(),
      usage: z.unknown().optional(),
    })
    .passthrough()
    .nullable(),
  error: z.object({ category: z.string(), message: z.string() }).nullable(),
})
async function run(
  args: string[],
  input: string | Buffer = '',
): Promise<{
  code: number | null
  stdout: string
  stderr: string
  json: z.infer<typeof envelopeSchema>
}> {
  const child = spawn(process.execPath, [entry, ...args, '--json'], {
    cwd: directory,
    env: {
      ...process.env,
      IMGRELAY_CONFIG_DIR: join(directory, 'config'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (value: string) => {
    stdout += value
  })
  child.stderr.setEncoding('utf8').on('data', (value: string) => {
    stderr += value
  })
  child.stdin.end(input)
  const code = await new Promise<number | null>((done, reject) => {
    child.on('error', reject)
    child.on('close', done)
  })
  return { code, stdout, stderr, json: envelopeSchema.parse(JSON.parse(stdout)) }
}
async function runPrompt(prompt: string, args: string[] = []) {
  return await run(['generate', '--prompt-stdin', ...args], prompt)
}
async function add(name: string, extra: string[] = []): Promise<void> {
  await new Store(join(directory, 'config')).put(name, {
    protocol: 'openai-images',
    baseUrl: `${url}/v1`,
    apiKey: KEY,
    defaultModel: `model-${name}`,
  })
  const result = await run(['provider', 'edit', name, ...extra])
  expect(result.json.error).toBeNull()
  expect(result.code).toBe(0)
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'imgrelay-cli-'))
  requests = []
  rejectAuth = false
  handler = undefined
  server = createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      const text = Buffer.concat(chunks).toString()
      const body = text ? z.record(z.string(), z.unknown()).parse(JSON.parse(text)) : {}
      requests.push({
        method: request.method || '',
        path: request.url || '',
        body,
        authorization: request.headers.authorization,
      })
      if (handler) {
        handler(request, response)
        return
      }
      response.setHeader('Content-Type', 'application/json')
      if (rejectAuth) {
        response.statusCode = 401
        response.end(
          JSON.stringify({ error: { message: `${KEY} https://example.com/image?token=secret` } }),
        )
        return
      }
      response.end(
        JSON.stringify(
          request.method === 'GET'
            ? { data: [{ id: 'vendor-unknown-model' }] }
            : { data: [{ b64_json: PNG }] },
        ),
      )
    })().catch(() => response.destroy())
  })
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No server address')
  url = `http://127.0.0.1:${address.port}`
})
afterEach(async () => {
  server.closeAllConnections()
  await new Promise<void>((done) => server.close(() => done()))
  if (!resolve(directory).startsWith(join(tmpdir(), 'imgrelay-cli-')))
    throw new Error('Unsafe cleanup path')
  await rm(directory, { recursive: true, force: true })
})

describe('真实命令行调用', () => {
  it('供应商 CRUD 与默认切换，不产生生成请求', async () => {
    await add('alpha', ['--default'])
    await add('beta')
    expect((await run(['provider', 'list'])).json.data?.providers).toHaveLength(2)
    expect((await run(['provider', 'edit', 'beta', '--model', 'edited-model'])).code).toBe(0)
    expect((await run(['provider', 'use', 'beta'])).code).toBe(0)
    expect((await run(['provider', 'show', 'beta'])).stdout).toContain('edited-model')
    expect((await run(['provider', 'remove', 'alpha'])).code).toBe(0)
    expect((await run(['provider', 'list'])).json.data?.providers).toHaveLength(1)
    expect(requests).toHaveLength(0)
  })

  it('models 缓存和 doctor 均为只读 API，生成只发送显式参数', async () => {
    await add('relay', ['--default'])
    expect((await run(['models'])).json.data?.cached).toBe(false)
    expect((await run(['models'])).json.data?.cached).toBe(true)
    expect((await run(['models', '--refresh'])).json.data?.cached).toBe(false)
    expect((await run(['doctor'])).code).toBe(0)
    expect(requests.every((request) => request.method === 'GET')).toBe(true)
    const prompt = '  换行\n"引号" 和 $() `字符`\n'
    const result = await runPrompt(prompt, ['--model', 'another-unknown-model'])
    expect(result.json.error).toBeNull()
    expect(result.code).toBe(0)
    expect(result.json.data?.images?.[0]?.width).toBe(1)
    expect(result.json.data?.requestedModel).toBe('another-unknown-model')
    expect(requests.at(-1)?.body).toEqual({ model: 'another-unknown-model', prompt, n: 1 })
    expect(JSON.parse(result.stdout) as unknown).toMatchObject({
      schemaVersion: 1,
      status: 'success',
      error: null,
    })
    expect(result.stdout).not.toContain(PNG)
    expect(result.stdout).not.toContain(KEY)
    expect(result.stderr).toContain('已保存')
  })

  it('命令指定另一供应商仅影响本次，提示词原样传递', async () => {
    await add('alpha', ['--default'])
    await add('beta', ['--base-url', `${url}/second/v1`])
    const prompt = '提示词\n保持原样'
    expect((await runPrompt(prompt, ['--provider', 'beta'])).code).toBe(0)
    expect(requests.at(-1)?.body.prompt).toBe(prompt)
    expect(requests.at(-1)?.body.model).toBe('model-beta')
    expect(requests.at(-1)?.path).toBe('/second/v1/images/generations')
    expect((await runPrompt('second')).code).toBe(0)
    expect(requests.at(-1)?.body.model).toBe('model-alpha')
    expect(requests.at(-1)?.path).toBe('/v1/images/generations')
  })

  it('缺失、互斥、空白或无效 UTF-8 输入在生成前报错', async () => {
    await add('relay', ['--default'])
    const blankFile = join(directory, 'blank.txt')
    const invalidFile = join(directory, 'invalid.txt')
    await writeFile(blankFile, '\uFEFF \r\n\t')
    await writeFile(invalidFile, Buffer.from([0xc3, 0x28]))
    const results = await Promise.all([
      run(['generate'], 'must not be read implicitly'),
      run(['generate', '--prompt-file']),
      run(['generate', '--prompt-file', '']),
      run(['generate', '--prompt-file', 'missing.txt']),
      run(['generate', '--prompt-file', blankFile]),
      run(['generate', '--prompt-file', invalidFile]),
      run(['generate', '--prompt-file', invalidFile, '--prompt-stdin'], 'test'),
      run(['generate', '--prompt-stdin', 'unused-text'], 'test'),
      runPrompt(''),
      runPrompt(' \r\n\t'),
      run(['generate', '--prompt-stdin'], Buffer.from([0xc3, 0x28])),
    ])
    for (const result of results) {
      expect(result.code).toBe(2)
      expect(result.json.error?.category).toBe('input_error')
      expect(result.json.data).toBeNull()
    }
    expect(requests).toHaveLength(0)
    await expect(readdir(join(directory, 'output'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('--prompt 立即报错并给出新输入方式，stdin 连字符原样发送', async () => {
    await add('relay', ['--default'])
    const results = await Promise.all(
      [
        ['generate', '--prompt', 'test'],
        ['generate', '--prompt=test'],
        ['generate', '--prompt', 'test', '--prompt-stdin'],
      ].map((args) => run(args)),
    )
    for (const removed of results) {
      expect(removed.code).toBe(2)
      expect(removed.json).toMatchObject({
        command: 'generate',
        data: null,
        error: { category: 'input_error' },
      })
      expect(removed.json.error?.message).toContain('--prompt 已移除')
      expect(removed.json.error?.message).toContain('--prompt-file')
      expect(removed.json.error?.message).toContain('--prompt-stdin')
    }
    expect(requests).toHaveLength(0)
    expect((await runPrompt('-')).code).toBe(0)
    expect(requests[0]?.body.prompt).toBe('-')
  })

  it.each(['file', 'stdin'] as const)(
    '%s 保留长多行文本、Unicode 和特殊字符及后续选项',
    async (source) => {
      await add('relay', ['--default'])
      const prompt =
        '\n \t中文 😀 "双引号" \'单引号\' \\ $() `字符` % & | ( )\r\n\n' +
        '蓝色角色\n'.repeat(2200) +
        '\t \r\n'
      const path = join(directory, 'prompt space.txt')
      const input = Buffer.from(`\uFEFF${prompt}`, 'utf8')
      await writeFile(path, input)
      const result = await run(
        [
          'generate',
          '--provider',
          'relay',
          ...(source === 'file' ? ['--prompt-file', path] : ['--prompt-stdin']),
          '--model',
          'selected-model',
          '--size',
          '1536x1536',
          '--n',
          '1',
          '--output-dir',
          './chosen images',
          '--filename',
          'chosen.png',
        ],
        source === 'stdin' ? input : '',
      )
      expect(prompt.length).toBeGreaterThan(8191)
      expect(result.code).toBe(0)
      expect(requests).toHaveLength(1)
      expect(requests[0]?.body).toEqual({
        model: 'selected-model',
        prompt,
        size: '1536x1536',
        n: 1,
      })
      const metadata = {
        promptSource: source === 'file' ? { type: 'file', path } : { type: 'stdin' },
        promptCharacters: prompt.length,
        promptUtf8Bytes: Buffer.byteLength(prompt),
        promptSha256: createHash('sha256').update(prompt).digest('hex'),
        outputDir: join(directory, 'chosen images'),
        filename: 'chosen.png',
        sources: {
          provider: 'explicit',
          model: 'explicit',
          parameters: { size: 'explicit', n: 'explicit' },
        },
      }
      expect(result.json.data).toMatchObject(metadata)
      expect(result.json.data?.images?.[0]?.path).toBe(
        join(directory, 'chosen images', 'chosen.png'),
      )
      const recordPath = result.json.data?.recordPath
      if (!recordPath) throw new Error('Missing generation record')
      expect(JSON.parse(await readFile(recordPath, 'utf8')) as unknown).toMatchObject({
        ...metadata,
        prompt,
      })
    },
  )

  it('dry-run 无需密钥，不联网、不写文件，仅输出有效配置与摘要', async () => {
    await add('relay', ['--default', '--quality', 'low'])
    await run(['provider', 'edit', 'relay', '--clear-key'])
    const configPath = join(directory, 'config', 'config.json')
    const config = await readFile(configPath)
    const prompt = ' \r\n中文 😀\n末行\t '
    const result = await runPrompt(prompt, [
      '--dry-run',
      '--size',
      '1536x1536',
      '--filename',
      'preview.png',
      '--timeout',
      '42',
    ])
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
    expect(result.json).toMatchObject({
      command: 'generate',
      status: 'success',
      error: null,
      data: {
        dryRun: true,
        credentialConfigured: false,
        submissionStatus: 'not_submitted',
        willSubmitNetworkRequest: false,
        provider: 'relay',
        requestedModel: 'model-relay',
        parameters: { n: 1, quality: 'low', size: '1536x1536' },
        promptSha256: createHash('sha256').update(prompt).digest('hex'),
        promptCharacters: prompt.length,
        promptUtf8Bytes: Buffer.byteLength(prompt),
        promptSource: { type: 'stdin' },
        outputDir: join(directory, 'output', 'imagegen'),
        filename: 'preview.png',
        overwrite: false,
        timeoutSeconds: 42,
        sources: {
          provider: 'default',
          model: 'provider_default',
          parameters: { n: 'tool_default', quality: 'provider_default', size: 'explicit' },
          outputDir: 'tool_default',
          filename: 'explicit',
          overwrite: 'tool_default',
          timeoutSeconds: 'explicit',
        },
      },
    })
    expect(result.json.data).not.toHaveProperty('prompt')
    expect(result.json.data).not.toHaveProperty('images')
    expect(result.json.data).not.toHaveProperty('recordPath')
    expect(requests).toHaveLength(0)
    expect(await readFile(configPath)).toEqual(config)
    expect(await readdir(join(directory, 'config'))).toEqual(['config.json'])
    await expect(readdir(join(directory, 'output'))).rejects.toMatchObject({ code: 'ENOENT' })
    const generated = await runPrompt(prompt)
    expect(generated.json.error?.category).toBe('credential_error')
    expect(requests).toHaveLength(0)
  })

  it('预览与实际请求参数一致；记录文本脱敏但摘要来自上游收到的原文', async () => {
    await add('relay', ['--default', '--size', 'auto', '--quality', 'low'])
    const prompt = `原样 ${KEY}\nhttps://example.com/reference?token=signed#fragment\n`
    const path = join(directory, 'prompt.txt')
    await writeFile(path, prompt)
    const args = ['generate', '--prompt-file', path, '--model', 'custom-model', '--quality', 'high']
    const preview = await run([...args, '--dry-run'])
    expect(preview.code).toBe(0)
    expect(preview.json.data?.credentialConfigured).toBe(true)
    expect(requests).toHaveLength(0)
    const generated = await run(args)
    expect(generated.code).toBe(0)
    expect(requests[0]?.body).toEqual({
      model: 'custom-model',
      prompt,
      n: 1,
      size: 'auto',
      quality: 'high',
    })
    for (const field of [
      'parameters',
      'sources',
      'promptSha256',
      'promptCharacters',
      'promptUtf8Bytes',
      'endpoint',
      'outputDir',
    ])
      expect(generated.json.data?.[field]).toEqual(preview.json.data?.[field])
    const recordPath = generated.json.data?.recordPath
    if (!recordPath) throw new Error('Missing record')
    const persisted = await readFile(recordPath, 'utf8')
    expect(persisted).not.toContain(KEY)
    expect(persisted).not.toContain('token=signed')
    expect(JSON.parse(persisted) as unknown).toMatchObject({
      promptSha256: createHash('sha256').update(prompt).digest('hex'),
      promptCharacters: prompt.length,
      promptUtf8Bytes: Buffer.byteLength(prompt),
    })
  })

  it.each([
    ['--model', 'gpt-image-1', '--size', '1536x1536'],
    ['--n', '0'],
    ['--timeout', '0'],
    ['--filename', '../invalid.png'],
    ['--model', ''],
  ])('dry-run 校验失败保持错误 JSON 且无副作用：%j', async (...args) => {
    await add('relay', ['--default'])
    const result = await runPrompt('test', ['--dry-run', ...args])
    expect(result.code).toBe(2)
    expect(result.json.status).toBe('error')
    expect(result.json.data).toBeNull()
    expect(requests).toHaveLength(0)
    expect(await readdir(join(directory, 'config'))).toEqual(['config.json'])
    await expect(readdir(join(directory, 'output'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('配置中的密钥编辑时保留且新进程输出脱敏，清除后无法生成', async () => {
    await add('managed')
    expect((await run(['provider', 'show', 'managed'])).stdout).not.toContain(KEY)
    const configPath = join(directory, 'config', 'config.json')
    expect(await readFile(configPath, 'utf8')).toContain(KEY)
    expect(await readdir(join(directory, 'config'))).toEqual(['config.json'])
    const edited = await run(['provider', 'edit', 'managed', '--model', 'edited-model'])
    expect(edited.code).toBe(0)
    expect(edited.stdout).not.toContain(KEY)
    expect((await runPrompt('test', ['--provider', 'managed'])).code).toBe(0)
    expect(requests.at(-1)?.authorization).toBe(`Bearer ${KEY}`)
    expect(requests.at(-1)?.body.model).toBe('edited-model')
    expect((await run(['provider', 'edit', 'managed', '--clear-key'])).code).toBe(0)
    expect((await runPrompt('test', ['--provider', 'managed'])).json.error?.category).toBe(
      'credential_error',
    )
    expect(await readFile(configPath, 'utf8')).not.toContain(KEY)
  })

  it('添加和修改均拒绝已移除的密钥选项，配置保持不变', async () => {
    await add('relay', ['--default'])
    const configPath = join(directory, 'config', 'config.json')
    const original = await readFile(configPath, 'utf8')
    expect((await run(['provider', 'list'])).stdout).toContain('"credentialSource":"config"')
    const options = ['--key-env', '--key-file', '--key-file-ref']
    const results = await Promise.all(
      ['add', 'edit'].flatMap((command) =>
        options.map((option) => run(['provider', command, 'relay', option, 'unused'])),
      ),
    )
    for (const result of results) {
      expect(result.code).toBe(2)
      expect(result.json.error?.category).toBe('input_error')
      expect(result.json.error?.message).toContain('unknown option')
      expect(result.stdout + result.stderr).not.toContain(KEY)
    }
    expect(await readFile(configPath, 'utf8')).toBe(original)
    expect(requests).toHaveLength(0)
  })

  it('非交互缺少信息及未知选项输出一个结构化错误，不等待输入', async () => {
    const missing = await run(['provider', 'add', 'missing'])
    expect(missing.code).toBe(2)
    expect(missing.json.status).toBe('error')
    expect(missing.json.error?.message).toContain('隐藏输入 API 密钥')
    const unknown = await run(['generate', '--not-an-option', 'value'])
    expect(unknown.code).toBe(2)
    expect(unknown.json.error?.category).toBe('input_error')
    expect((await runPrompt('test')).json.error?.category).toBe('config_error')
  })

  it('上游回显密钥不会出现在 stdout、stderr、记录中', async () => {
    await add('relay', ['--default'])
    rejectAuth = true
    const result = await runPrompt('test')
    expect(result.code).toBe(3)
    expect(result.json.error?.category).toBe('auth_error')
    expect(result.stdout + result.stderr).not.toContain(KEY)
    expect(result.stdout + result.stderr).not.toContain('token=secret')
    const path = result.json.data?.recordPath
    if (!path) throw new Error('Missing record')
    expect(await readFile(path, 'utf8')).not.toContain(KEY)
  })

  it('JSON help 与 version 也保持单一 JSON 输出', async () => {
    expect((await run(['--help'])).code).toBe(0)
    const version = await run(['--version'])
    expect(version.code).toBe(0)
    expect(version.json).toMatchObject({
      status: 'success',
      data: { help: packageJson.version },
      error: null,
    })
  })

  it('非交互新增即使提供地址、模型和预设也需要隐藏输入密钥', async () => {
    const added = await run([
      'provider',
      'add',
      'cubence',
      '--preset',
      'cubence',
      '--base-url',
      url,
      '--model',
      'model',
      '--default',
    ])
    expect(added.code).toBe(2)
    expect(added.json.error?.category).toBe('config_error')
    expect(added.json.error?.message).toContain('交互终端不带 --json')
    await expect(readdir(join(directory, 'config'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(requests).toHaveLength(0)
  })

  it('完整生成地址和端点覆盖不会破坏模型查询路径', async () => {
    await add('relay', ['--base-url', `${url}/proxy/images/generations/`, '--default'])
    expect((await run(['doctor'])).code).toBe(0)
    expect(requests.at(-1)?.path).toBe('/proxy/v1/models')
    expect((await runPrompt('test')).code).toBe(0)
    expect(requests.at(-1)?.path).toBe('/proxy/images/generations')
    expect(
      (
        await run([
          'provider',
          'edit',
          'relay',
          '--base-url',
          `${url}/prefix/v1/`,
          '--models-path',
          '/catalog',
          '--generation-path',
          '/render',
        ])
      ).code,
    ).toBe(0)
    expect((await run(['models'])).code).toBe(0)
    expect(requests.at(-1)?.path).toBe('/prefix/v1/catalog')
    expect((await runPrompt('test')).code).toBe(0)
    expect(requests.at(-1)?.path).toBe('/prefix/v1/render')
  })

  it('模型列表缺失时仍能使用默认及手动未知模型', async () => {
    await add('relay', ['--default'])
    handler = (request, response) => {
      response.setHeader('Content-Type', 'application/json')
      if (request.method === 'GET') {
        response.statusCode = 404
        response.end('{}')
      } else response.end(JSON.stringify({ data: [{ b64_json: PNG }] }))
    }
    expect((await run(['models'])).code).toBe(3)
    const checked = await run(['doctor'])
    expect(checked.json.data).toMatchObject({
      configuration: 'valid',
      authentication: 'unknown',
      generation: 'not_verified',
    })
    expect((await runPrompt('default')).code).toBe(0)
    const generated = await runPrompt('manual', [
      '--model',
      'vendor/custom:2026',
      '--size',
      'vendor-size',
      '--quality',
      'vendor-quality',
    ])
    expect(generated.code).toBe(0)
    expect(requests.at(-1)?.body).toMatchObject({
      model: 'vendor/custom:2026',
      size: 'vendor-size',
      quality: 'vendor-quality',
    })
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(2)
  })

  it('参数覆盖仅影响本次，能力错误保存记录且不换参数或提交', async () => {
    await add('relay', [
      '--default',
      '--size',
      'auto',
      '--quality',
      'low',
      '--output-format',
      'jpeg',
    ])
    expect((await runPrompt('override', ['--quality', 'high'])).code).toBe(0)
    expect(requests.at(-1)?.body).toMatchObject({
      size: 'auto',
      quality: 'high',
      output_format: 'jpeg',
      n: 1,
    })
    expect((await runPrompt('default')).code).toBe(0)
    expect(requests.at(-1)?.body.quality).toBe('low')
    const capabilityFile = join(directory, 'capabilities.json')
    await writeFile(
      capabilityFile,
      JSON.stringify({
        'model-relay': {
          source: 'provider_override',
          verifiedAt: '2026-10-10T00:00:00.000Z',
          parameters: { n: { max: 1 } },
        },
      }),
    )
    expect(
      (await run(['provider', 'edit', 'relay', '--capabilities-file', capabilityFile])).code,
    ).toBe(0)
    const rejected = await runPrompt('rejected', ['--n', '2'])
    expect(rejected.code).toBe(2)
    expect(rejected.json.error?.category).toBe('parameter_unsupported')
    expect(rejected.json.data?.recordPath).toEqual(expect.any(String))
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(2)
  })

  it('混合 Base64、URL 和失败项返回部分成功，保留原图和真实用量', async () => {
    await add('relay', ['--default'])
    handler = (request, response) => {
      if (request.method === 'POST') {
        response.setHeader('Content-Type', 'application/json')
        response.end(
          JSON.stringify({
            data: [
              { b64_json: PNG, url: `${url}/never?key=signed` },
              { b64_json: 'invalid!' },
              { url: `${url}/redirect?token=signed` },
            ],
            usage: { input_tokens: 8, output_tokens: 20 },
            model: 'upstream-reported',
          }),
        )
      } else if (request.url?.startsWith('/redirect')) {
        response.writeHead(302, { Location: '/download?token=signed' })
        response.end()
      } else {
        response.writeHead(200, { 'Content-Type': 'image/png' })
        response.end(Buffer.from(PNG, 'base64'))
      }
    }
    const result = await runPrompt('test', [
      '--n',
      '3',
      '--size',
      '2048x1024',
      '--output-format',
      'jpeg',
      '--filename',
      'named.jpg',
    ])
    expect(result.code).toBe(5)
    expect(result.json.status).toBe('partial_success')
    expect(result.json.data?.images).toHaveLength(2)
    expect(result.json.data?.failures?.[0]?.error.category).toBe('image_decode_error')
    expect(result.json.data?.images?.[0]).toMatchObject({
      width: 1,
      height: 1,
      format: 'png',
      bytes: Buffer.from(PNG, 'base64').length,
    })
    expect(result.json.data).toMatchObject({
      usage: { input_tokens: 8, output_tokens: 20 },
      reportedModel: 'upstream-reported',
    })
    expect(
      requests
        .filter((request) => request.method === 'GET')
        .map((request) => request.authorization),
    ).toEqual([undefined, undefined])
    const path = result.json.data?.images?.[0]?.path
    const record = result.json.data?.recordPath
    if (!path || !record) throw new Error('Missing saved result')
    expect(path).toContain('named-01.png')
    expect(await readFile(path)).toEqual(Buffer.from(PNG, 'base64'))
    const persisted = await readFile(record, 'utf8')
    expect(persisted + result.stdout).not.toContain('token=signed')
    expect(persisted + result.stdout).not.toContain(PNG)
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(1)
  })

  it('超时和断网返回结果未知，生成 POST 始终只有一次', async () => {
    await add('relay', ['--default'])
    handler = () => {
      /* Keep the response pending until the CLI timeout. */
    }
    const timedOut = await runPrompt('test', ['--timeout', '0.05'])
    expect(timedOut.code).toBe(3)
    expect(timedOut.json.status).toBe('unknown')
    expect(requests).toHaveLength(1)
    handler = (_request, response) => response.destroy()
    const disconnected = await runPrompt('test')
    expect(disconnected.json.error?.category).toBe('result_unknown')
    expect(requests).toHaveLength(2)
  })

  it('已有图片默认不覆盖，显式 overwrite 才允许替换', async () => {
    await add('relay', ['--default'])
    const image = join(directory, 'output', 'imagegen', 'named.png')
    expect((await runPrompt('first', ['--filename', 'named.png'])).code).toBe(0)
    await writeFile(image, 'existing-image')
    expect((await runPrompt('second', ['--filename', 'named.png'])).code).toBe(4)
    expect(await readFile(image, 'utf8')).toBe('existing-image')
    expect(requests).toHaveLength(1)
    expect((await runPrompt('third', ['--filename', 'named.png', '--overwrite'])).code).toBe(0)
    expect(await readFile(image)).toEqual(Buffer.from(PNG, 'base64'))
    expect(requests).toHaveLength(2)
  })

  it('供应商及配置中的密钥分别隔离模型缓存', async () => {
    await add('alpha', ['--default'])
    await add('beta')
    expect((await run(['models'])).json.data?.models?.[0]?.id).toBe('vendor-unknown-model')
    expect((await run(['models'])).json.data?.cached).toBe(true)
    expect((await run(['models', '--provider', 'beta'])).json.data?.cached).toBe(false)
    const fixtureStore = new Store(join(directory, 'config'))
    const selected = await fixtureStore.selected('alpha')
    await fixtureStore.put('alpha', selected.provider, { edit: true, secret: 'changed-key' })
    expect((await run(['models'])).json.data?.cached).toBe(false)
    expect(requests.at(-1)?.authorization).toBe('Bearer changed-key')
    const cache = await readFile(join(directory, 'config', 'models-cache.json'), 'utf8')
    expect(cache).not.toContain(KEY)
    expect(cache).not.toContain('changed-key')
  })

  it('响应大小限制不追加生成，并保留后续成功图片', async () => {
    await add('relay', ['--default'])
    handler = (request, response) => {
      if (request.method === 'POST')
        response.end(JSON.stringify({ data: [{ url: `${url}/large` }, { b64_json: PNG }] }))
      else {
        response.writeHead(200, { 'Content-Length': String(32 * 1024 * 1024 + 1) })
        response.end()
      }
    }
    const partial = await runPrompt('test', ['--n', '2'])
    expect(partial.code).toBe(5)
    expect(partial.json.data?.images).toHaveLength(1)
    handler = (_request, response) => {
      response.writeHead(200, { 'Content-Length': String(128 * 1024 * 1024 + 1) })
      response.end()
    }
    const oversized = await runPrompt('test')
    expect(oversized.code).toBe(3)
    expect(oversized.json.error?.category).toBe('invalid_response')
    expect(requests.filter((request) => request.method === 'POST')).toHaveLength(2)
  })

  it('无效配置版本、未知字段及不合法参数在生成前报错', async () => {
    await add('relay', ['--default'])
    expect((await runPrompt('test', ['--n', '0'])).code).toBe(2)
    const path = join(directory, 'config', 'config.json')
    const valid: unknown = JSON.parse(await readFile(path, 'utf8'))
    await writeFile(path, JSON.stringify({ schemaVersion: 99, providers: {} }))
    expect((await run(['provider', 'list'])).json.error?.category).toBe('config_error')
    await writeFile(
      path,
      JSON.stringify({ ...z.record(z.string(), z.unknown()).parse(valid), unexpected: true }),
    )
    expect((await run(['provider', 'list'])).code).toBe(2)
    expect(requests).toHaveLength(0)
  })
})
