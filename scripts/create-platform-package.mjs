import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const packageRoot = resolve(scriptDir, '..')
const packageJson = JSON.parse(
  readFileSync(resolve(packageRoot, 'package.json'), 'utf8')
)

const target = readArg('--target') ?? inferTarget()
const binaryPath = resolve(
  packageRoot,
  readArg('--binary') ?? 'bin/vsock_proxy'
)
const packageName = `${packageJson.name}-${target}`
const outputDir = resolve(packageRoot, 'npm', target)
const outputBin = resolve(outputDir, 'bin/vsock_proxy')
const targetMetadata = metadataForTarget(target)

mkdirSync(resolve(outputDir, 'bin'), { recursive: true })
copyFileSync(binaryPath, outputBin)
chmodSync(outputBin, 0o755)

writeFileSync(
  resolve(outputDir, 'package.json'),
  `${JSON.stringify(
    {
      name: packageName,
      version: packageJson.version,
      description: `Prebuilt AWS Nitro Enclaves vsock proxy binary for ${target}.`,
      repository: packageJson.repository,
      license: packageJson.license,
      os: [targetMetadata.os],
      cpu: [targetMetadata.cpu],
      libc: [targetMetadata.libc],
      files: ['bin/vsock_proxy'],
      exports: {
        './bin/vsock_proxy': './bin/vsock_proxy',
        './package.json': './package.json',
      },
      publishConfig: packageJson.publishConfig,
    },
    null,
    '\t'
  )}\n`
)

console.log(`Created ${packageName} in ${outputDir}`)

function readArg(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? null : process.argv[index + 1]
}

function inferTarget() {
  if (process.platform !== 'linux') {
    throw new Error(
      `Cannot infer a Linux package target from ${process.platform}`
    )
  }
  if (process.arch === 'x64') return 'linux-x64-gnu'
  if (process.arch === 'arm64') return 'linux-arm64-gnu'
  throw new Error(`Unsupported architecture: ${process.arch}`)
}

function metadataForTarget(target) {
  if (target === 'linux-x64-gnu') {
    return { cpu: 'x64', libc: 'glibc', os: 'linux' }
  }
  if (target === 'linux-arm64-gnu') {
    return { cpu: 'arm64', libc: 'glibc', os: 'linux' }
  }
  throw new Error(`Unsupported target: ${target}`)
}
