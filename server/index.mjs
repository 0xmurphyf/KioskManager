import { ArchiveEvents, ArchiveService } from './archive-service.mjs';
import { loadConfig } from './config.mjs';
import { ArchiveStore } from './database.mjs';
import { GraphqlArchiveSource } from './graphql-source.mjs';
import { createArchiveHttpServer } from './http-server.mjs';
import { SuiArchiveListener } from './sui-listener.mjs';

const config = loadConfig();
const store = new ArchiveStore(config.databasePath);
const events = new ArchiveEvents();
const source = new GraphqlArchiveSource({
  endpoint: config.graphqlUrl,
  eventType: config.eventType,
  timeoutMs: config.graphqlTimeoutMs,
});
const service = new ArchiveService({
  store,
  source,
  events,
  eventType: config.eventType,
  retryCount: config.objectRetryCount,
  retryBaseMs: config.objectRetryBaseMs,
});
const abortController = new AbortController();
const runtime = {
  startedAt: new Date().toISOString(),
  reconciling: false,
  lastReconcileError: null,
};

function isCursorError(error) {
  return /cursor|invalid.*after|malformed.*page/i.test(String(error?.message || error));
}

async function reconcile({ full = false } = {}) {
  runtime.reconciling = true;
  try {
    let result;
    try {
      result = await service.reconcile({ full, signal: abortController.signal });
    } catch (error) {
      if (full || !store.getMeta('graphqlCursor') || !isCursorError(error)) throw error;
      console.warn('[archive] saved GraphQL cursor expired; rebuilding the cache index');
      store.setMeta('graphqlCursor', null);
      result = await service.reconcile({ full: true, signal: abortController.signal });
    }
    runtime.lastReconcileError = null;
    return result;
  } catch (error) {
    runtime.lastReconcileError = String(error?.message || error);
    console.error(`[archive] reconciliation failed: ${runtime.lastReconcileError}`);
    throw error;
  } finally {
    runtime.reconciling = false;
  }
}

const listener = new SuiArchiveListener({
  baseUrl: config.grpcUrl,
  eventType: config.eventType,
  onEvent: (event, signal) => service.ingest(event, { signal }),
  onConnected: () => {
    void reconcile().catch(() => {});
    const catchUpTimer = setTimeout(
      () => void reconcile().catch(() => {}),
      Math.max(config.objectRetryBaseMs * 4, 5_000),
    );
    catchUpTimer.unref();
  },
  reconnectBaseMs: config.reconnectBaseMs,
  reconnectMaxMs: config.reconnectMaxMs,
});

const server = createArchiveHttpServer({
  store,
  events,
  packageId: config.packageId,
  eventType: config.eventType,
  staticDir: config.staticDir,
  corsOrigin: config.corsOrigin,
  maxSseClients: config.maxSseClients,
  health: () => ({
    startedAt: runtime.startedAt,
    reconciling: runtime.reconciling,
    lastReconciledAt: store.getMeta('lastReconciledAt'),
    lastReconcileError: runtime.lastReconcileError,
    listener: listener.status(),
  }),
});

server.listen(config.port, config.host, () => {
  console.info(`[archive] listening on http://${config.host}:${config.port}`);
});

void listener.run(abortController.signal);

const startupReconcileTimer = setTimeout(
  () => void reconcile().catch(() => {}),
  5_000,
);
startupReconcileTimer.unref();

const reconcileTimer = setInterval(
  () => void reconcile().catch(() => {}),
  config.reconcileIntervalMs,
);
reconcileTimer.unref();

let shuttingDown = false;
function shutdown(signalName) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.info(`[archive] received ${signalName}; shutting down`);
  clearTimeout(startupReconcileTimer);
  clearInterval(reconcileTimer);
  abortController.abort(new Error(signalName));
  server.close(() => {
    store.close();
  });
  setTimeout(() => server.closeAllConnections(), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
