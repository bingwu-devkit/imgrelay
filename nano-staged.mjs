import { extname, join } from 'node:path'

const lintExtensions = new Set(['.cjs', '.cts', '.js', '.jsx', '.mjs', '.mts', '.ts', '.tsx'])
const formatExtensions = new Set([...lintExtensions, '.json', '.jsonc', '.md', '.yaml', '.yml'])
const repositoryRoot = import.meta.dirname

function quote(value) {
  return `"${value}"`
}

function createCommands(filenames, { command, configName, extensions }) {
  const files = filenames.filter((file) => extensions.has(extname(file)))

  if (files.length === 0) return []

  const config = join(repositoryRoot, configName)
  return [`${command} -c ${quote(config)} ${files.map((file) => quote(file)).join(' ')}`]
}

export default ({ filenames }) => [
  ...createCommands(filenames, {
    command: 'oxlint --fix --no-error-on-unmatched-pattern',
    configName: 'oxlint.config.ts',
    extensions: lintExtensions,
  }),
  ...createCommands(filenames, {
    command: 'oxfmt --write --disable-nested-config --no-error-on-unmatched-pattern',
    configName: 'oxfmt.config.ts',
    extensions: formatExtensions,
  }),
]
