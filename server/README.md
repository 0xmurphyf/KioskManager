# The Archive server

This Node service keeps a durable cache of the deployed Testnet package's
`MemoryArchived` events. It listens over Sui gRPC, reconciles through GraphQL,
stores complete archive objects in SQLite, exposes JSON and SSE APIs, and serves
the repository's `dist/` website from the same process.

## Run

Requires Node 22.12 or newer.

```sh
pnpm --dir server install --ignore-workspace
pnpm --dir server start
```

On Railway, persist `server/data` with a volume and use
`pnpm --dir server start` as the start command. Build the frontend before the
service starts so that `dist/index.html` exists.

Configuration is documented in `.env.example`. The default network is Sui
Testnet and the default reconciliation interval is one hour.

## API

- `GET /api/archives` — cached archives and cache metadata
- `GET /api/health` — cache and listener health
- `GET /api/archives/stream` — SSE; new records use event name `archive`
- `GET /api/owned-objects?address=0x...` — merged NFT/Kiosk ownership from the configured indexer

Owned-object indexer configuration:

- `OWNED_OBJECTS_INDEXER_ENDPOINT` — defaults to TradePort's read-only GraphQL endpoint
- `OWNED_OBJECTS_INDEXER_API_USER` / `OWNED_OBJECTS_INDEXER_API_KEY` — optional overrides for deployments
- `OWNED_OBJECTS_INDEXER_TIMEOUT_MS` — request timeout, default 15000
- `OWNED_OBJECTS_INDEXER_PAGE_SIZE` — NFT page size, default 100

Run the isolated tests with `pnpm --dir server test`.
