# The Archive

The Archive preserves Sui objects as immutable memories. The current deployment
indexes the Testnet package at
`0x7c2d81512cd71d4a396cbec4a035b75f670d1a56151db6bf5a10a48f3efa5a0b`.

## How the live archive works

- A Node service subscribes to `memory_archive::MemoryArchived` over Sui gRPC.
- Each successful archive is enriched from Sui GraphQL and stored in SQLite.
- The website reads `/api/archives` first, so records and whispers render without
  waiting for a browser-side chain scan.
- `/api/archives/stream` pushes new archives to open browsers through SSE.
- Startup, reconnect, and hourly GraphQL reconciliation recover missed events.

The server also serves the built Vite site, so one Railway service can run the
listener, API, and frontend.

## Local development

Requirements: Node.js 22.12 or newer and pnpm 11.

```bash
pnpm install
pnpm dev
```

Run the production-shaped service locally:

```bash
pnpm build
pnpm start
```

The default URL is `http://localhost:3000`. Run the backend tests with
`pnpm test`.

## Railway

Connect this repository and use:

- Build command: `pnpm build`
- Start command: `pnpm start`
- Health check: `/api/health`

For cache persistence across deployments, mount a Railway volume and set
`ARCHIVE_DATABASE_PATH=/data/archive.sqlite`. The service reconstructs the
cache from Testnet if the database starts empty.

Optional server settings are documented in
[`server/.env.example`](server/.env.example).

## Wallet support

The frontend detects Wallet Standard wallets through Sui dApp Kit, including
Slush, OKX, Binance Wallet when its Sui provider is registered, and Phantom's
injected Sui provider.
