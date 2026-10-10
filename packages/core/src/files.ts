import { randomUUID } from 'node:crypto'
import { lstat, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import { ImgRelayError } from './errors.js'

export function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

export async function assertRegular(path: string): Promise<void> {
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new ImgRelayError('credential_error', '配置或凭据文件必须是普通文件，不能使用符号链接')
  }
}

export async function writeAtomic(path: string, value: unknown): Promise<void> {
  const temporary = join(dirname(path), `.${randomUUID()}.tmp`)
  const handle = await open(temporary, 'wx')
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    await rename(temporary, path)
  } finally {
    await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
  }
}

export async function readJson(path: string): Promise<unknown> {
  await assertRegular(path)
  return JSON.parse(await readFile(path, 'utf8')) as unknown
}
