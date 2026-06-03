import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const VSOCK_PROXY_BINARY_NAME = 'vsock_proxy'
export const VSOCK_PROXY_BINARY_ENV =
  'AWS_NITRO_ENCLAVES_VSOCK_PROXY_BIN'

const PACKAGE_NAME = '@nerd-coder/aws-nitro-enclaves-vsock'
const BUN_VIRTUAL_FS_PREFIX = '/$bunfs/'

export interface ResolveVsockProxyBinaryOptions {
  /** Absolute path to a proxy binary. Takes precedence over all discovery. */
  binaryPath?: string
  /** Environment map used for AWS_NITRO_ENCLAVES_VSOCK_PROXY_BIN lookup. */
  env?: NodeJS.ProcessEnv
  /** Working directory to search for colocated binaries. */
  cwd?: string
  /** Runtime executable path. Defaults to process.execPath. */
  execPath?: string
}

export function getVsockProxyPlatformPackageName(
  platform = process.platform,
  arch = process.arch
): string | null {
  if (platform !== 'linux') return null
  if (arch === 'x64') return `${PACKAGE_NAME}-linux-x64-gnu`
  if (arch === 'arm64') return `${PACKAGE_NAME}-linux-arm64-gnu`
  return null
}

export function resolveVsockProxyBinary(
  options: ResolveVsockProxyBinaryOptions = {}
): string {
  const env = options.env ?? process.env
  const override = options.binaryPath ?? env[VSOCK_PROXY_BINARY_ENV]
  if (override) return requireExistingBinary(override)

  const candidates = [
    ...runtimeBinaryCandidates(options),
    resolvePlatformPackageBinary(),
    join(resolvePackageRoot(), 'bin', VSOCK_PROXY_BINARY_NAME),
    join(resolvePackageRoot(), 'build', VSOCK_PROXY_BINARY_NAME),
  ].filter((candidate): candidate is string => candidate !== null)

  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }

  const platformPackage = getVsockProxyPlatformPackageName()
  throw new Error(
    [
      'Unable to locate the AWS Nitro Enclaves vsock proxy binary.',
      platformPackage
        ? `Expected optional package ${platformPackage} to provide it.`
        : `Unsupported platform ${process.platform}/${process.arch}.`,
      `Set ${VSOCK_PROXY_BINARY_ENV} to an absolute proxy binary path to override discovery.`,
    ].join(' ')
  )
}

function requireExistingBinary(path: string): string {
  if (!existsSync(path)) {
    throw new Error(`VSock proxy binary does not exist: ${path}`)
  }
  return path
}

function runtimeBinaryCandidates(
  options: ResolveVsockProxyBinaryOptions
): string[] {
  const cwd = options.cwd ?? process.cwd()
  const executableDir = dirname(options.execPath ?? process.execPath)
  const candidates = [
    join(executableDir, VSOCK_PROXY_BINARY_NAME),
    join(executableDir, 'bin', VSOCK_PROXY_BINARY_NAME),
    join(cwd, VSOCK_PROXY_BINARY_NAME),
    join(cwd, 'bin', VSOCK_PROXY_BINARY_NAME),
  ]

  if (isBundledExecutable()) {
    candidates.push(join(cwd, '..', VSOCK_PROXY_BINARY_NAME))
  }

  return candidates
}

function resolvePlatformPackageBinary(): string | null {
  const platformPackage = getVsockProxyPlatformPackageName()
  if (platformPackage === null) return null

  try {
    return createRequire(import.meta.url).resolve(
      `${platformPackage}/bin/${VSOCK_PROXY_BINARY_NAME}`
    )
  } catch {
    return null
  }
}

function resolvePackageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..')
}

function isBundledExecutable(): boolean {
  try {
    return fileURLToPath(import.meta.url).startsWith(BUN_VIRTUAL_FS_PREFIX)
  } catch {
    return false
  }
}
