import { describe, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildHostsContent,
  buildVsockEgressEndpoints,
  getVsockProxyPlatformPackageName,
  parseVsockProxyMap,
  resolveVsockProxyBinary,
  VSOCK_PROXY_BINARY_ENV,
} from './index.ts'

describe('platform package names', () => {
  test('resolves Linux npm packages', () => {
    expect(getVsockProxyPlatformPackageName('linux', 'x64')).toBe(
      '@nerd-coder/aws-nitro-enclaves-vsock-linux-x64-gnu'
    )
    expect(getVsockProxyPlatformPackageName('linux', 'arm64')).toBe(
      '@nerd-coder/aws-nitro-enclaves-vsock-linux-arm64-gnu'
    )
  })

  test('rejects unsupported platforms', () => {
    expect(getVsockProxyPlatformPackageName('darwin', 'arm64')).toBe(null)
  })
})

describe('binary resolution', () => {
  test('uses explicit environment override', () => {
    const tmpDir = '/private/tmp/aws-nitro-enclaves-vsock-test'
    const binary = join(tmpDir, 'vsock_proxy')
    mkdirSync(tmpDir, { recursive: true })
    writeFileSync(binary, '#!/bin/sh\n')
    chmodSync(binary, 0o755)

    expect(
      resolveVsockProxyBinary({
        env: { [VSOCK_PROXY_BINARY_ENV]: binary },
      })
    ).toBe(binary)
  })
})

describe('egress host mapping', () => {
  test('parses proxy maps into normalized routes', () => {
    expect(parseVsockProxyMap('Example.COM.=9000, api.test=9001')).toEqual([
      { domain: 'example.com', vsockPort: 9000 },
      { domain: 'api.test', vsockPort: 9001 },
    ])
  })

  test('assigns deterministic loopback endpoints', () => {
    expect(buildVsockEgressEndpoints('a.test=9000,b.test=9001')).toEqual([
      {
        domain: 'a.test',
        loopbackAddress: '127.77.0.1',
        vsockPort: 9000,
      },
      {
        domain: 'b.test',
        loopbackAddress: '127.77.0.2',
        vsockPort: 9001,
      },
    ])
  })

  test('replaces previous generated hosts block', () => {
    const endpoints = buildVsockEgressEndpoints('api.test=9000')
    const first = buildHostsContent('127.0.0.1 localhost\n', endpoints)
    const second = buildHostsContent(first, endpoints)

    expect(second.match(/api\.test/g)?.length).toBe(1)
    expect(second).toContain('127.77.0.1 api.test')
  })
})
