# AWS Nitro Enclaves VSock

[![npm version](https://img.shields.io/npm/v/@nerd-coder/aws-nitro-enclaves-vsock.svg)](https://www.npmjs.com/package/@nerd-coder/aws-nitro-enclaves-vsock)

TypeScript helpers and prebuilt proxy binaries for AWS Nitro Enclaves VSock
networking.

This package is designed for TypeScript applications running inside an AWS
Nitro Enclave. It gives the application a normal HTTP/TLS programming model
while a small native C helper handles Linux `AF_VSOCK` sockets.

## Package

- npm package: `@nerd-coder/aws-nitro-enclaves-vsock`
- native layer: C proxy process
- package manager: Bun, pinned through `mise.toml`
- supported native targets:
  - `x86_64-unknown-linux-gnu`
  - `aarch64-unknown-linux-gnu`

macOS and Windows are intentionally unsupported for the native proxy because
AWS Nitro Enclaves VSock is a Linux runtime surface.

## Why a Proxy Process

JavaScript runtimes do not expose Nitro `AF_VSOCK` as a regular `net.Socket` or
`fetch` transport. This package keeps the VSock-specific work in a native helper
process and lets TypeScript code use ordinary Unix sockets, loopback TCP, and
HTTPS clients.

Keeping the relay as a process also makes it easy to inspect, terminate, and
restart. A `.node` addon is a better fit for short request/response bindings
such as NSM attestation. For long-running socket relays, a process boundary is
more operationally useful.

## API

```ts
import {
  startIngressProxy,
  startVsockProxySet,
} from "@nerd-coder/aws-nitro-enclaves-vsock";

const inbound = startIngressProxy({
  unixSocket: "/tmp/app.sock",
  vsockPort: 8000,
});

console.log(inbound.pid, inbound.command);
```

For an enclave app that needs both inbound and outbound bridges:

```ts
import { startVsockProxySet } from "@nerd-coder/aws-nitro-enclaves-vsock";

const proxies = startVsockProxySet({
  inbound: {
    unixSocket: "/tmp/app.sock",
    vsockPort: 8000,
  },
  outbound: {
    proxyMap: "api.example.com=9000,fullnode.example.com=9001",
  },
});

for (const proxy of proxies) {
  console.log(proxy.role, proxy.pid);
}
```

Outbound mode writes a generated block to `/etc/hosts` by default, mapping each
configured domain to a deterministic `127.77.x.x` address. The native proxy
then listens on that loopback address at port `443` and relays the connection to
the parent instance CID `3` on the configured VSock port.

The proxy adds each generated `127.77.x.x` address to `lo` before binding. In a
minimal enclave network namespace, binding an unconfigured loopback address can
produce a visible listener that local clients still cannot reach. Treat this as
kernel loopback setup, not client-runtime behavior.

## Binary Resolution

The TypeScript wrapper locates the native proxy in this order:

1. explicit `binaryPath`
2. `AWS_NITRO_ENCLAVES_VSOCK_PROXY_BIN`
3. a `vsock_proxy` binary colocated with `process.execPath`
4. the installed optional platform package
5. `bin/vsock_proxy` in this package

The colocated `process.execPath` lookup is useful for Bun standalone
executables, where the final enclave image can copy `vsock_proxy` next to the
compiled TypeScript application.

## CLI

```sh
aws-nitro-enclaves-vsock-proxy /tmp/app.sock 8000
aws-nitro-enclaves-vsock-proxy egress 127.77.0.1 443 9000
```

## Development

Install the pinned tools with mise:

```sh
mise install
```

Install dependencies:

```sh
bun install --frozen-lockfile
```

Build the TypeScript package:

```sh
bun run build
```

Build the native proxy on Linux:

```sh
bun run build:proxy
```

Run local checks:

```sh
bun run check
```

The native proxy requires Linux headers such as `linux/vm_sockets.h`; local
macOS checks only validate TypeScript and pure helper behavior.

## CI and Release Setup

The `Publish` workflow builds native proxy packages for Linux x64 and Linux
arm64, creates a release commit/tag with `release-it`, publishes the platform
packages, then publishes the main TypeScript package.

npm authentication and provenance are expected to use npm Trusted Publisher
with the workflow filename `publish.yml`, so no `NPM_TOKEN` secret is required.

Recommended branch protection:

- Require normal CI checks before merging pull requests to `main`.
- If `main` is protected, allow the `Publish` workflow or a dedicated release
  token to push release commits and tags after the workflow's checks pass.
