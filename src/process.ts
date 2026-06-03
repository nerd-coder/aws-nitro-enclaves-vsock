import {
  type ChildProcessWithoutNullStreams,
  type StdioOptions,
  spawn,
} from 'node:child_process'
import {
  type ResolveVsockProxyBinaryOptions,
  resolveVsockProxyBinary,
} from './binary.ts'

export interface SpawnVsockProxyOptions extends ResolveVsockProxyBinaryOptions {
  cwd?: string
  detached?: boolean
  env?: NodeJS.ProcessEnv
  stdio?: StdioOptions
}

export interface VsockProxyProcess {
  command: string[]
  child: ChildProcessWithoutNullStreams
  exited: Promise<number | null>
  kill(signal?: NodeJS.Signals | number): boolean
  pid: number | undefined
}

export function spawnVsockProxy(
  args: string[],
  options: SpawnVsockProxyOptions = {}
): VsockProxyProcess {
  const binary = resolveVsockProxyBinary(options)
  const command = [binary, ...args]
  const child = spawn(binary, args, {
    cwd: options.cwd,
    detached: options.detached,
    env: options.env,
    stdio: options.stdio ?? ['ignore', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams

  const exited = new Promise<number | null>((resolve, reject) => {
    child.once('exit', (code) => resolve(code))
    child.once('error', reject)
  })

  return {
    child,
    command,
    exited,
    kill: (signal) => child.kill(signal),
    pid: child.pid,
  }
}
