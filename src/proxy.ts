import {
  buildVsockEgressEndpoints,
  DEFAULT_EGRESS_LISTEN_PORT,
  writeEgressHostsFile,
  type VsockEgressEndpoint,
} from './hosts.ts'
import {
  spawnVsockProxy,
  type SpawnVsockProxyOptions,
  type VsockProxyProcess,
} from './process.ts'

export const NITRO_PARENT_CID = 3

export interface IngressProxyConfig extends SpawnVsockProxyOptions {
  unixSocket: string
  vsockPort: number
}

export interface EgressProxyConfig extends SpawnVsockProxyOptions {
  hostVsockPort: number
  listenAddress: string
  listenPort?: number
}

export interface ProxySetInboundConfig {
  unixSocket: string
  vsockPort: number
}

export interface ProxySetOutboundConfig {
  hostsPath?: string
  listenPort?: number
  proxyMap: string
}

export interface StartProxySetConfig extends SpawnVsockProxyOptions {
  inbound?: ProxySetInboundConfig
  outbound?: ProxySetOutboundConfig
}

export interface StartedVsockProxy extends VsockProxyProcess {
  listenAddress: string | null
  listenPort: number | null
  role: string
  vsockPort: number | null
}

export function startIngressProxy(
  config: IngressProxyConfig
): StartedVsockProxy {
  validatePort(config.vsockPort, 'vsockPort')
  const process = spawnVsockProxy(
    [config.unixSocket, String(config.vsockPort)],
    config
  )
  return {
    ...process,
    listenAddress: null,
    listenPort: null,
    role: 'inbound',
    vsockPort: null,
  }
}

export function startEgressProxy(
  config: EgressProxyConfig
): StartedVsockProxy {
  const listenPort = config.listenPort ?? DEFAULT_EGRESS_LISTEN_PORT
  validatePort(listenPort, 'listenPort')
  validatePort(config.hostVsockPort, 'hostVsockPort')

  const process = spawnVsockProxy(
    [
      'egress',
      config.listenAddress,
      String(listenPort),
      String(config.hostVsockPort),
    ],
    config
  )
  return {
    ...process,
    listenAddress: config.listenAddress,
    listenPort,
    role: `outbound:${config.listenAddress}`,
    vsockPort: config.hostVsockPort,
  }
}

export function startVsockProxySet(
  config: StartProxySetConfig
): StartedVsockProxy[] {
  const processes: StartedVsockProxy[] = []

  if (config.inbound) {
    processes.push(
      startIngressProxy({
        ...config,
        unixSocket: config.inbound.unixSocket,
        vsockPort: config.inbound.vsockPort,
      })
    )
  }

  if (config.outbound) {
    const endpoints = buildVsockEgressEndpoints(config.outbound.proxyMap)
    writeEgressHostsFile(endpoints, config.outbound.hostsPath)
    processes.push(...startEgressProxies(endpoints, config))
  }

  return processes
}

function startEgressProxies(
  endpoints: VsockEgressEndpoint[],
  config: StartProxySetConfig
): StartedVsockProxy[] {
  return endpoints.map((endpoint) => ({
    ...startEgressProxy({
      ...config,
      hostVsockPort: endpoint.vsockPort,
      listenAddress: endpoint.loopbackAddress,
      listenPort:
        config.outbound?.listenPort ?? DEFAULT_EGRESS_LISTEN_PORT,
    }),
    role: `outbound:${endpoint.domain}`,
  }))
}

function validatePort(port: number, label: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${label} must be an integer from 1 to 65535`)
  }
}
