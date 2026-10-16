#!/usr/bin/env node
import { doctor, generate, ImgRelayError, models, previewGenerate, Store } from '@imgrelay/core'
import type { ErrorInfo } from '@imgrelay/core'
import { Command, CommanderError } from 'commander'

import packageJson from '../package.json' with { type: 'json' }
import { readPrompt } from './prompt.js'
import { configureProvider, listProviders, providerOptions } from './provider.js'
import type { ProviderFlags } from './provider.js'

const json = process.argv.includes('--json')
const controller = new AbortController()
process.once('SIGINT', () => controller.abort())
process.once('SIGTERM', () => controller.abort())
let commandName = 'imgrelay'
let outputWritten = false
let helpOutput = ''
let store: Store | undefined
// Only true while the generate action is still in the CLI's offline preparation phase.
let generationNotSubmitted = false

function output(
  data: unknown,
  options: { status?: string; exitCode?: number; error?: ErrorInfo } = {},
): void {
  if (outputWritten) return
  outputWritten = true
  const envelope = {
    schemaVersion: 1,
    command: commandName,
    status: options.status || 'success',
    data,
    error: options.error || null,
  }
  const safe = store ? store.redactor.value(envelope) : envelope
  if (json) process.stdout.write(`${JSON.stringify(safe)}\n`)
  else {
    if (options.error)
      process.stderr.write(
        `${store?.redactor.text(options.error.message) || options.error.message}\n`,
      )
    if (data !== null)
      process.stdout.write(
        `${JSON.stringify(store ? store.redactor.value(data) : data, null, 2)}\n`,
      )
  }
  process.exitCode = options.exitCode || 0
}

function active(name: string): Store {
  commandName = name
  store ||= new Store()
  return store
}

const program = new Command()
  .name('imgrelay')
  .description('通过统一入口调用 OpenAI Images 兼容中转站')
  .version(packageJson.version)
  .option('--json', '输出一个最终 JSON 对象，禁用交互输入')
  .exitOverride()
  .configureOutput({
    writeOut: (value) => {
      if (json) helpOutput += value
      else process.stdout.write(value)
    },
    writeErr: (value) => {
      if (!json) process.stderr.write(value)
    },
  })

const provider = program.command('provider').description('管理供应商配置与凭据')
providerOptions(provider.command('add <名称>').description('添加供应商')).action(
  async (name: string, flags: ProviderFlags) => {
    const current = active('provider add')
    const result = await configureProvider(
      current,
      name,
      flags,
      !json && process.stdin.isTTY && process.stdout.isTTY,
      controller.signal,
    )
    output({ provider: name, configuration: result })
  },
)
providerOptions(provider.command('edit <名称>').description('修改供应商')).action(
  async (name: string, flags: ProviderFlags) => {
    const current = active('provider edit')
    const existing = await current.selected(name)
    const result = await configureProvider(
      current,
      name,
      flags,
      !json && process.stdin.isTTY && process.stdout.isTTY,
      controller.signal,
      existing.provider,
    )
    output({ provider: name, configuration: result })
  },
)
provider
  .command('list')
  .description('列出供应商，交互选择默认供应商')
  .action(async () => {
    const current = active('provider list')
    output(
      await listProviders(
        current,
        !json && process.stdin.isTTY && process.stdout.isTTY,
        controller.signal,
      ),
    )
  })
provider
  .command('show <名称>')
  .description('查看脱敏配置')
  .action(async (name: string) => {
    const current = active('provider show')
    const selected = await current.selected(name)
    output({ provider: name, configuration: selected.provider })
  })
provider
  .command('use <名称>')
  .description('设置默认供应商')
  .action(async (name: string) => {
    const current = active('provider use')
    await current.use(name)
    output({ defaultProvider: name })
  })
provider
  .command('remove <名称>')
  .description('移除供应商及其已保存的密钥')
  .action(async (name: string) => {
    const current = active('provider remove')
    await current.remove(name)
    output({ removed: name })
  })
program
  .command('models')
  .description('查询模型列表或查看 15 分钟缓存')
  .option('--provider <名称>', '本次使用的供应商')
  .option('--refresh', '强制刷新模型列表')
  .action(async (flags: { provider?: string; refresh?: boolean }) => {
    const current = active('models')
    output(await models(current, { ...flags, signal: controller.signal }))
  })
program
  .command('doctor')
  .description('检查配置与模型接口，不生成图片')
  .option('--provider <名称>', '检查指定供应商')
  .action(async (flags: { provider?: string }) => {
    const current = active('doctor')
    const result = await doctor(current, { ...flags, signal: controller.signal })
    output(result.data, {
      status: result.exitCode ? 'error' : 'success',
      exitCode: result.exitCode,
      ...(result.error ? { error: result.error } : {}),
    })
  })
program
  .command('generate')
  .description('生成图片并保存原图和记录')
  .allowExcessArguments(false)
  .option('--prompt-file <路径>', '读取 UTF-8 提示词文件，与 --prompt-stdin 互斥')
  .option('--prompt-stdin', '从管道或重定向读取 UTF-8 提示词，与 --prompt-file 互斥')
  .option('--dry-run', '离线预览有效请求，不联网、不写文件，无需密钥')
  .option('--provider <名称>', '本次使用的供应商')
  .option('--model <ID>', '本次使用的模型')
  .option('--size <尺寸>', '图片尺寸，如 auto 或 1024x1024')
  .option('--n <数量>', '请求图片数量，不自动拆单')
  .option('--quality <质量>', '请求质量')
  .option('--output-format <格式>', '请求图片格式')
  .option('--output-dir <目录>', '保存目录，默认 output/imagegen')
  .option('--filename <名称>', '文件名；多图追加序号，扩展名按实际格式')
  .option('--overwrite', '允许覆盖图片文件')
  .option('--timeout <秒数>', '生成等待超时，默认 600 秒')
  .action(
    async (flags: {
      promptFile?: string
      promptStdin?: boolean
      dryRun?: boolean
      provider?: string
      model?: string
      size?: string
      n?: string
      quality?: string
      outputFormat?: string
      outputDir?: string
      filename?: string
      overwrite?: boolean
      timeout?: string
    }) => {
      const current = active('generate')
      generationNotSubmitted = true
      const prompt = await readPrompt(flags, controller.signal)
      const options = {
        ...prompt,
        ...(flags.provider !== undefined ? { provider: flags.provider } : {}),
        ...(flags.model !== undefined ? { model: flags.model } : {}),
        ...(flags.size !== undefined ? { size: flags.size } : {}),
        ...(flags.n !== undefined ? { n: Number(flags.n) } : {}),
        ...(flags.quality !== undefined ? { quality: flags.quality } : {}),
        ...(flags.outputFormat !== undefined ? { outputFormat: flags.outputFormat } : {}),
        ...(flags.outputDir !== undefined ? { outputDir: flags.outputDir } : {}),
        ...(flags.filename !== undefined ? { filename: flags.filename } : {}),
        ...(flags.timeout !== undefined ? { timeoutSeconds: Number(flags.timeout) } : {}),
        overwrite: Boolean(flags.overwrite),
        signal: controller.signal,
        progress: (message: string) => process.stderr.write(`${message}\n`),
      }
      if (flags.dryRun) {
        output(await previewGenerate(current, options))
        return
      }
      generationNotSubmitted = false
      const result = await generate(current, options)
      output(result.data, {
        status: result.status,
        exitCode: result.exitCode,
        ...(result.error ? { error: result.error } : {}),
      })
    },
  )
program.action(() => {
  if (json) output({ help: program.helpInformation() })
  else program.outputHelp()
})

try {
  await program.parseAsync(process.argv)
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) {
    if (json) output({ help: helpOutput.trim() })
    process.exitCode = 0
  } else {
    const removedPrompt =
      error instanceof CommanderError &&
      error.code === 'commander.unknownOption' &&
      (error.message.includes("'--prompt'") || error.message.includes("'--prompt="))
    if (removedPrompt) commandName = 'generate'
    const failure =
      error instanceof CommanderError
        ? new ImgRelayError(
            'input_error',
            removedPrompt
              ? '--prompt 已移除，请改用 --prompt-file <路径> 或 --prompt-stdin'
              : error.message,
          )
        : error
    const info: ErrorInfo = store
      ? store.redactor.error(failure)
      : {
          category: failure instanceof ImgRelayError ? failure.category : 'internal_error',
          message: failure instanceof Error ? failure.message : '发生未知错误',
        }
    output(generationNotSubmitted ? { submissionStatus: 'not_submitted' } : null, {
      status: info.category === 'interrupted' ? 'interrupted' : 'error',
      exitCode: failure instanceof ImgRelayError ? failure.exitCode : 1,
      error: info,
    })
  }
}
