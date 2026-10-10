import { execFileSync, spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'imgrelay-package space-'))
if (!resolve(temporary).startsWith(join(tmpdir(), 'imgrelay-package space-')))
  throw new Error('Unsafe cleanup path')
function resolveCommand(name) {
  if (process.platform !== 'win32') return name
  return execFileSync('where.exe', [`${name}.cmd`], { encoding: 'utf8', windowsHide: true })
    .trim()
    .split(/\r?\n/)[0]
}
const pnpm = resolveCommand('pnpm')
const npm = resolveCommand('npm')

async function run(command, args, cwd = root) {
  return await new Promise((done, reject) => {
    const needsCmd = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd')
    const line = needsCmd
      ? [command, ...args]
          .map((value) => {
            if (/["%!\r\n]/.test(value)) throw new Error('Unsupported command path')
            return `"${value}"`
          })
          .join(' ')
      : ''
    const child = spawn(
      needsCmd ? process.env.ComSpec || 'cmd.exe' : command,
      needsCmd ? ['/d', '/s', '/c', `"${line}"`] : args,
      {
        cwd,
        windowsHide: true,
        windowsVerbatimArguments: needsCmd,
        env: { ...process.env, IMGRELAY_CONFIG_DIR: join(temporary, 'config') },
      },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) done(stdout)
      else reject(new Error(`${command} exited ${code}: ${stderr}`))
    })
  })
}

try {
  await run(pnpm, ['pack', '--pack-destination', temporary], join(root, 'packages', 'cli'))
  const archive = (await readdir(temporary)).find((name) => name.endsWith('.tgz'))
  if (!archive) throw new Error('Package archive missing')
  await run(npm, [
    'install',
    '--prefix',
    temporary,
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    join(temporary, archive),
  ])
  const packagePath = join(temporary, 'node_modules', 'imgrelay')
  const manifest = JSON.parse(await readFile(join(packagePath, 'package.json'), 'utf8'))
  if (manifest.dependencies?.['@imgrelay/core'])
    throw new Error('Private core leaked into published dependencies')
  await readFile(join(packagePath, 'LICENSE.md'))
  await readFile(join(packagePath, 'README.md'))
  const executable = join(
    temporary,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'imgrelay.cmd' : 'imgrelay',
  )
  const result = JSON.parse(await run(executable, ['provider', 'list', '--json'], temporary))
  if (result.status !== 'success' || result.data.providers.length !== 0)
    throw new Error('Installed command smoke test failed')
  console.log('打包安装验证通过：独立 CLI、许可证、README 和命令入口均可用。')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
