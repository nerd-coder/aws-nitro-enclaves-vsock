#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { resolveVsockProxyBinary } from '../dist/index.js'

const child = spawn(resolveVsockProxyBinary(), process.argv.slice(2), {
  stdio: 'inherit',
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal))
}

child.once('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal)
    return
  }

  process.exit(code ?? 1)
})
