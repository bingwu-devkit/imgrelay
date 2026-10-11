import { PassThrough, Readable } from 'node:stream'

import { describe, expect, it } from 'vitest'

import { readPrompt } from '../src/prompt.js'

describe('stdin 输入边界', () => {
  it('交互终端直接报错，不等待读取', async () => {
    const terminal = Object.assign(new PassThrough(), { isTTY: true })
    await expect(readPrompt({ promptStdin: true }, undefined, terminal)).rejects.toMatchObject({
      category: 'input_error',
      exitCode: 2,
    })
    expect(terminal.readableFlowing).toBeNull()
    terminal.destroy()
  })

  it('等待 stdin 时中断会结束读取，退出码为 130', async () => {
    const input = new PassThrough()
    const controller = new AbortController()
    const pending = readPrompt({ promptStdin: true }, controller.signal, input)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ category: 'interrupted', exitCode: 130 })
    expect(input.destroyed).toBe(true)
  })

  it('跨字节块解码 Unicode，仅去除一个开头 BOM，保留后续 BOM 及空白', async () => {
    const prompt = '\uFEFF\n 中文 😀\r\n\t '
    const bytes = Buffer.from(`\uFEFF${prompt}`)
    const input = Readable.from(Array.from(bytes, (byte) => Buffer.from([byte])))
    expect(await readPrompt({ promptStdin: true }, undefined, input)).toEqual({
      prompt,
      promptSource: { type: 'stdin' },
    })
  })
})
