/* Installed generation inputs are checked one request at a time. */
/* eslint-disable no-await-in-loop */
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const temporary = await mkdtemp(join(tmpdir(), 'imgrelay-package space-'))
if (!resolve(temporary).startsWith(join(tmpdir(), 'imgrelay-package space-')))
  throw new Error('Unsafe cleanup path')
function resolveCommand(name) {
  if (process.platform !== 'win32') return name
  const executable = execFileSync('where.exe', [name], { encoding: 'utf8', windowsHide: true })
    .trim()
    .split(/\r?\n/)
    .find((path) => /\.(exe|cmd|bat)$/i.test(path))
  if (!executable) throw new Error(`Cannot locate ${name} executable`)
  return executable
}
const quote = (value) => `'${value.replaceAll("'", "''")}'`
const pnpm = resolveCommand('pnpm')
const npm = resolveCommand('npm')

async function run(command, args, cwd = root, input = '') {
  return await new Promise((done, reject) => {
    const needsCmd = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)
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
    child.stdin.end(input)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) done(stdout)
      else reject(new Error(`${command} exited ${code}: ${stderr}`))
    })
  })
}

const received = []
const server = createServer((request, response) => {
  void (async () => {
    const chunks = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    response.setHeader('Content-Type', 'application/json')
    response.end(
      JSON.stringify({
        data: [
          {
            b64_json:
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aJf8AAAAASUVORK5CYII=',
          },
        ],
      }),
    )
  })().catch(() => response.destroy())
})

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
  await new Promise((ready) => server.listen(0, '127.0.0.1', ready))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Mock server address missing')
  const config = {
    schemaVersion: 1,
    defaultProvider: 'mock',
    providers: {
      mock: {
        protocol: 'openai-images',
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        defaultModel: 'smoke-model',
      },
    },
  }
  const configDir = join(temporary, 'config')
  const configPath = join(configDir, 'config.json')
  await mkdir(configDir)
  await writeFile(configPath, JSON.stringify(config))
  const prompt =
    '\n中文 😀 "引号" \'单引号\' \\ $() `字符` % & | ( )\r\n\n' +
    '长提示词\n'.repeat(2200) +
    '\t \r\n'
  const promptPath = join(temporary, 'prompt space.txt')
  await writeFile(promptPath, `\uFEFF${prompt}`)
  const digest = createHash('sha256').update(prompt).digest('hex')
  function verifyPreview(preview) {
    if (
      preview.status !== 'success' ||
      preview.data.promptSha256 !== digest ||
      preview.data.promptCharacters !== prompt.length ||
      preview.data.promptUtf8Bytes !== Buffer.byteLength(prompt) ||
      preview.data.parameters.size !== '1536x1536' ||
      preview.data.credentialConfigured !== false ||
      preview.data.willSubmitNetworkRequest !== false ||
      preview.data.submissionStatus !== 'not_submitted'
    )
      throw new Error('Installed dry-run changed prompt or options')
  }
  for (const source of ['file', 'stdin']) {
    const args = [
      'generate',
      '--dry-run',
      ...(source === 'file' ? ['--prompt-file', promptPath] : ['--prompt-stdin']),
      '--size',
      '1536x1536',
      '--json',
    ]
    verifyPreview(
      JSON.parse(await run(executable, args, temporary, source === 'stdin' ? prompt : '')),
    )
  }
  if (process.platform === 'win32') {
    const wrapper = join(temporary, 'outer.cmd')
    await writeFile(
      wrapper,
      '@echo off\r\n"%~dp0node_modules\\.bin\\imgrelay.cmd" %*\r\nexit /b %ERRORLEVEL%\r\n',
    )
    verifyPreview(
      JSON.parse(
        await run(
          wrapper,
          ['generate', '--prompt-stdin', '--size', '1536x1536', '--dry-run', '--json'],
          temporary,
          prompt,
        ),
      ),
    )
    const script = `& ${quote(wrapper)} generate --prompt-file ${quote(promptPath)} --size 1536x1536 --dry-run --json; exit $LASTEXITCODE`
    for (const powershell of ['pwsh.exe', 'powershell.exe'])
      verifyPreview(
        JSON.parse(
          await run(powershell, ['-NoProfile', '-NonInteractive', '-Command', script], temporary),
        ),
      )
  }
  if (received.length || (await readdir(configDir)).join() !== 'config.json')
    throw new Error('Dry-run accessed network or wrote configuration/cache')
  if ((await readdir(temporary)).includes('output'))
    throw new Error('Dry-run created an output directory')
  config.providers.mock.apiKey = 'offline-smoke-secret'
  await writeFile(configPath, JSON.stringify(config))
  for (const source of ['file', 'stdin']) {
    const args = [
      'generate',
      '--provider',
      'mock',
      ...(source === 'file' ? ['--prompt-file', promptPath] : ['--prompt-stdin']),
      '--model',
      'smoke-model',
      '--size',
      '1536x1536',
      '--n',
      '1',
      '--output-dir',
      './chosen images',
      '--filename',
      `${source}.png`,
      '--json',
    ]
    const generated = JSON.parse(
      await run(executable, args, temporary, source === 'stdin' ? prompt : ''),
    )
    if (
      generated.status !== 'success' ||
      generated.data.promptSha256 !== digest ||
      generated.data.images[0]?.path !== join(temporary, 'chosen images', `${source}.png`)
    )
      throw new Error('Installed generation did not preserve options')
    const body = received.at(-1)
    if (
      body.prompt !== prompt ||
      body.model !== 'smoke-model' ||
      body.size !== '1536x1536' ||
      body.n !== 1
    )
      throw new Error('Installed launcher changed the HTTP request')
    const record = JSON.parse(await readFile(generated.data.recordPath, 'utf8'))
    if (record.prompt !== prompt || record.promptSha256 !== digest)
      throw new Error('Installed record changed prompt')
  }
  if (received.length !== 2) throw new Error('Unexpected network request count')
  console.log('打包安装验证通过：独立 CLI、文件/stdin 长提示词、离线预览与 mock 请求均可用。')
} finally {
  server.closeAllConnections()
  await new Promise((done) => server.close(done))
  await rm(temporary, { recursive: true, force: true })
}
