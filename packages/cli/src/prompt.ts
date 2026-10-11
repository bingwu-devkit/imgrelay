import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { Readable } from 'node:stream'

import { ImgRelayError } from '@imgrelay/core'
import type { PromptSource } from '@imgrelay/core'

export interface PromptFlags {
  promptFile?: string
  promptStdin?: boolean
}

function interrupted(): ImgRelayError {
  return new ImgRelayError('interrupted', '用户中断读取提示词，未提交生成请求', 130)
}

export async function readPrompt(
  flags: PromptFlags,
  signal?: AbortSignal,
  stdin: Readable & { isTTY?: boolean } = process.stdin,
): Promise<{ prompt: string; promptSource: PromptSource }> {
  if (Number(flags.promptFile !== undefined) + Number(Boolean(flags.promptStdin)) !== 1)
    throw new ImgRelayError('input_error', '必须且只能指定 --prompt-file 或 --prompt-stdin')
  if (signal?.aborted) throw interrupted()
  let bytes: Buffer
  let promptSource: PromptSource
  if (flags.promptFile !== undefined) {
    if (!flags.promptFile.trim())
      throw new ImgRelayError('input_error', '--prompt-file 路径不能为空')
    const path = resolve(flags.promptFile)
    try {
      bytes = await readFile(path, signal ? { signal } : {})
    } catch {
      if (signal?.aborted) throw interrupted()
      throw new ImgRelayError('input_error', '无法读取 --prompt-file；请检查文件路径及访问权限')
    }
    promptSource = { type: 'file', path }
  } else {
    if (stdin.isTTY)
      throw new ImgRelayError(
        'input_error',
        '--prompt-stdin 需要管道或重定向输入；也可使用 --prompt-file',
      )
    const abort = () => stdin.destroy(interrupted())
    signal?.addEventListener('abort', abort, { once: true })
    const chunks: Buffer[] = []
    try {
      for await (const chunk of stdin) chunks.push(Buffer.from(chunk))
      bytes = Buffer.concat(chunks)
    } catch {
      if (signal?.aborted) throw interrupted()
      throw new ImgRelayError('input_error', '无法读取 stdin 提示词')
    } finally {
      signal?.removeEventListener('abort', abort)
    }
    promptSource = { type: 'stdin' }
  }
  if (signal?.aborted) throw interrupted()
  let prompt: string
  try {
    prompt = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    throw new ImgRelayError('input_error', '提示词必须是有效 UTF-8 文本')
  }
  if (prompt.startsWith('\uFEFF')) prompt = prompt.slice(1)
  if (!prompt.trim()) throw new ImgRelayError('input_error', '提示词不能为空或全空白')
  return { prompt, promptSource }
}
