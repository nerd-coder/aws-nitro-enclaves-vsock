import { spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
const outputPath = resolve(packageRoot, readArg('--out') ?? 'bin/vsock_proxy')
const sourcePath = resolve(packageRoot, 'native/vsock_proxy.c')

mkdirSync(dirname(outputPath), { recursive: true })

const result = spawnSync(
  'gcc',
  ['-O2', '-Wall', '-Wextra', sourcePath, '-o', outputPath, '-lpthread'],
  {
    stdio: 'inherit',
  }
)

if (result.error) throw result.error
if (result.status !== 0) {
  throw new Error(`gcc failed with exit code ${result.status}`)
}

console.log(`Built ${outputPath}`)

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}
