import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PACKAGE_ID =
  '0x7c2d81512cd71d4a396cbec4a035b75f670d1a56151db6bf5a10a48f3efa5a0b';

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function loadConfig(env = process.env) {
  const serverDir = fileURLToPath(new URL('.', import.meta.url));
  const rootDir = resolve(serverDir, '..');
  const packageId = (env.SUI_PACKAGE_ID || DEFAULT_PACKAGE_ID).toLowerCase();

  return {
    host: env.HOST || '0.0.0.0',
    port: positiveInteger(env.PORT, 3000),
    corsOrigin: env.CORS_ORIGIN || '*',
    databasePath: resolve(rootDir, env.ARCHIVE_DATABASE_PATH || 'server/data/archive.sqlite'),
    staticDir: resolve(rootDir, env.STATIC_DIR || 'dist'),
    packageId,
    eventType:
      env.SUI_ARCHIVE_EVENT_TYPE || `${packageId}::memory_archive::MemoryArchived`,
    graphqlUrl: env.SUI_GRAPHQL_URL || 'https://graphql.testnet.sui.io/graphql',
    grpcUrl: env.SUI_GRPC_URL || 'https://fullnode.testnet.sui.io:443',
    reconcileIntervalMs: positiveInteger(env.RECONCILE_INTERVAL_MS, 60 * 60 * 1000),
    graphqlTimeoutMs: positiveInteger(env.GRAPHQL_TIMEOUT_MS, 15_000),
    objectRetryCount: positiveInteger(env.OBJECT_RETRY_COUNT, 8),
    objectRetryBaseMs: positiveInteger(env.OBJECT_RETRY_BASE_MS, 750),
    reconnectBaseMs: positiveInteger(env.GRPC_RECONNECT_BASE_MS, 1_000),
    reconnectMaxMs: positiveInteger(env.GRPC_RECONNECT_MAX_MS, 30_000),
    maxSseClients: positiveInteger(env.MAX_SSE_CLIENTS, 250),
  };
}
