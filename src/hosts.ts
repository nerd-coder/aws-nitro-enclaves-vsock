import { existsSync, readFileSync, writeFileSync } from 'node:fs'

export const DEFAULT_EGRESS_HOSTS_PATH = '/etc/hosts'
export const DEFAULT_EGRESS_LISTEN_PORT = 443

const HOSTS_BLOCK_BEGIN = '# aws-nitro-enclaves-vsock egress begin'
const HOSTS_BLOCK_END = '# aws-nitro-enclaves-vsock egress end'
const LOOPBACK_SECOND_OCTET = 77
const LOOPBACK_HOSTS_PER_SUBNET = 254
const LOOPBACK_SUBNET_COUNT = 254

export interface VsockProxyRoute {
  domain: string
  vsockPort: number
}

export interface VsockEgressEndpoint extends VsockProxyRoute {
  loopbackAddress: string
}

export function parseVsockProxyMap(proxyMap: string): VsockProxyRoute[] {
  const entries = proxyMap
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  const seenDomains = new Set<string>()
  const routes: VsockProxyRoute[] = []

  for (const entry of entries) {
    const parts = entry.split('=')
    const rawDomain = parts[0]
    const rawPort = parts[1]
    if (
      parts.length !== 2 ||
      rawDomain === undefined ||
      rawPort === undefined
    ) {
      throw new Error(
        `VSock proxy map entries must use domain=vsockPort: ${entry}`
      )
    }

    const domain = normalizeDomain(rawDomain)
    if (seenDomains.has(domain)) {
      throw new Error(`VSock proxy map has duplicate domain: ${domain}`)
    }

    seenDomains.add(domain)
    routes.push({ domain, vsockPort: parsePort(rawPort, entry) })
  }

  return routes
}

export function buildVsockEgressEndpoints(
  routesOrProxyMap: string | VsockProxyRoute[]
): VsockEgressEndpoint[] {
  const routes =
    typeof routesOrProxyMap === 'string'
      ? parseVsockProxyMap(routesOrProxyMap)
      : routesOrProxyMap

  return routes.map((route, index) => ({
    ...route,
    loopbackAddress: loopbackAddressForIndex(index),
  }))
}

export function buildHostsContent(
  currentContent: string,
  endpoints: VsockEgressEndpoint[]
): string {
  const withoutGeneratedBlock = currentContent
    .replace(generatedHostsBlockPattern(), '')
    .trimEnd()

  if (endpoints.length === 0) {
    return withoutGeneratedBlock ? `${withoutGeneratedBlock}\n` : ''
  }

  const block = [
    HOSTS_BLOCK_BEGIN,
    '# Generated from AWS Nitro Enclaves vsock egress configuration.',
    ...endpoints.map(
      (endpoint) => `${endpoint.loopbackAddress} ${endpoint.domain}`
    ),
    HOSTS_BLOCK_END,
  ].join('\n')

  return `${withoutGeneratedBlock}${withoutGeneratedBlock ? '\n\n' : ''}${block}\n`
}

export function writeEgressHostsFile(
  endpoints: VsockEgressEndpoint[],
  hostsPath = DEFAULT_EGRESS_HOSTS_PATH
): void {
  const currentContent = existsSync(hostsPath)
    ? readFileSync(hostsPath, 'utf8')
    : ''
  writeFileSync(hostsPath, buildHostsContent(currentContent, endpoints))
}

function loopbackAddressForIndex(index: number): string {
  if (index < 0 || index >= LOOPBACK_HOSTS_PER_SUBNET * LOOPBACK_SUBNET_COUNT) {
    throw new Error('VSock proxy map has too many entries')
  }

  const thirdOctet = Math.floor(index / LOOPBACK_HOSTS_PER_SUBNET)
  const fourthOctet = (index % LOOPBACK_HOSTS_PER_SUBNET) + 1
  return `127.${LOOPBACK_SECOND_OCTET}.${thirdOctet}.${fourthOctet}`
}

function normalizeDomain(rawDomain: string): string {
  const domain = rawDomain.trim().toLowerCase().replace(/\.$/, '')
  const labels = domain.split('.')

  if (
    domain.length === 0 ||
    domain.length > 253 ||
    domain.includes('/') ||
    domain.includes(':') ||
    labels.some((label) => !isValidHostnameLabel(label))
  ) {
    throw new Error(`VSock proxy map contains invalid domain: ${rawDomain}`)
  }

  return domain
}

function isValidHostnameLabel(label: string): boolean {
  return (
    label.length > 0 &&
    label.length <= 63 &&
    /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(label)
  )
}

function parsePort(rawPort: string, entry: string): number {
  const port = Number(rawPort.trim())
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`VSock proxy map contains invalid vsock port: ${entry}`)
  }

  return port
}

function generatedHostsBlockPattern(): RegExp {
  return new RegExp(
    `${escapeRegExp(HOSTS_BLOCK_BEGIN)}[\\s\\S]*?${escapeRegExp(
      HOSTS_BLOCK_END
    )}\\n?`,
    'g'
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
