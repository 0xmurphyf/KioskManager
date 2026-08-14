import './wallet.js';
import {
  ARCHIVE_STREAM_URL,
  EVENT_TYPE,
  PACKAGE_ID,
  loadCachedArchives,
  scanArchives,
} from './chain-archives.js';

const status = document.getElementById('archiveScanStatus');
const refreshButton = document.getElementById('scanArchivesBtn');
let currentArchives = [];
let hasRenderedArchives = false;
let archiveStream;
let streamRetryTimer;
let streamCacheRefresh;

function mergeArchives(existing, incoming) {
  const archivesById = new Map();

  for (const archive of [...existing, ...incoming]) {
    if (!archive?.archiveId) continue;
    const previous = archivesById.get(archive.archiveId) || {};
    archivesById.set(archive.archiveId, {
      ...previous,
      ...archive,
      content: { ...(previous.content || {}), ...(archive.content || {}) },
    });
  }

  return [...archivesById.values()].sort(
    (a, b) => Number(b.archivedAtMs || 0) - Number(a.archivedAtMs || 0),
  );
}

function renderArchives(archives) {
  currentArchives = mergeArchives(currentArchives, archives);
  hasRenderedArchives = true;
  window.renderChainArchives(currentArchives, { packageId: PACKAGE_ID, eventType: EVENT_TYPE });
}

function archivesFromStream(payload) {
  if (Array.isArray(payload)) return payload;
  if (Array.isArray(payload?.archives)) return payload.archives;
  if (Array.isArray(payload?.data?.archives)) return payload.data.archives;
  if (payload?.archive) return [payload.archive];
  if (payload?.data?.archive) return [payload.data.archive];
  if (payload?.archiveId) return [payload];
  if (payload?.data?.archiveId) return [payload.data];
  return [];
}

function refreshCacheFromStream() {
  if (streamCacheRefresh) return streamCacheRefresh;

  streamCacheRefresh = loadCachedArchives()
    .then((cached) => {
      renderArchives(cached.archives);
      status.textContent = `${currentArchives.length} immutable archive${currentArchives.length === 1 ? '' : 's'} synced from the live Sui listener.`;
      status.className = 'scan-status ready';
    })
    .catch((error) => console.warn('Could not refresh the archive cache after a stream event', error))
    .finally(() => {
      streamCacheRefresh = undefined;
    });

  return streamCacheRefresh;
}

function startArchiveStream() {
  if (!('EventSource' in window) || archiveStream) return;

  archiveStream = new EventSource(ARCHIVE_STREAM_URL);
  const handleEvent = (event) => {
    try {
      const archives = archivesFromStream(JSON.parse(event.data));
      if (archives.length) renderArchives(archives);
    } catch (error) {
      console.warn('Ignored an invalid archive stream event', error);
    }
    void refreshCacheFromStream();
  };

  archiveStream.onmessage = handleEvent;
  for (const eventName of ['ready', 'archive', 'archives', 'snapshot']) {
    archiveStream.addEventListener(eventName, handleEvent);
  }
  archiveStream.onerror = () => {
    archiveStream.close();
    archiveStream = undefined;
    clearTimeout(streamRetryTimer);
    streamRetryTimer = setTimeout(startArchiveStream, 60_000);
  };
}

async function refreshChainArchives({ background = false } = {}) {
  if (!background) {
    refreshButton.disabled = true;
    refreshButton.classList.add('is-loading');
    refreshButton.textContent = 'Scanning Mainnet…';
    status.textContent = 'Reading MemoryArchived events and their immutable objects…';
    status.className = 'scan-status loading';
  }

  try {
    const archives = await scanArchives();
    renderArchives(archives);
    status.textContent = `${currentArchives.length} immutable archive${currentArchives.length === 1 ? '' : 's'} indexed from Sui Mainnet.`;
    status.className = 'scan-status ready';
  } catch (error) {
    console.error('Could not scan archive events', error);
    if (hasRenderedArchives) {
      status.textContent = `${currentArchives.length} cached archive${currentArchives.length === 1 ? '' : 's'} shown. Live Mainnet refresh is temporarily unavailable.`;
      status.className = 'scan-status ready';
    } else {
      window.renderChainArchiveError(error);
      status.textContent = `Unable to read Mainnet: ${error.message}`;
      status.className = 'scan-status error';
    }
  } finally {
    if (!background) {
      refreshButton.disabled = false;
      refreshButton.classList.remove('is-loading');
      refreshButton.textContent = 'Refresh on-chain data';
    }
  }
}

async function initializeArchives() {
  refreshButton.disabled = true;
  refreshButton.classList.add('is-loading');
  refreshButton.textContent = 'Loading archive…';
  status.textContent = 'Loading the latest archived objects from cache…';
  status.className = 'scan-status loading';

  try {
    const cached = await loadCachedArchives();
    renderArchives(cached.archives);
    const source = cached.source === 'api' ? 'server cache' : 'cached snapshot';
    status.textContent = `${currentArchives.length} immutable archive${currentArchives.length === 1 ? '' : 's'} loaded from the ${source}.`;
    status.className = 'scan-status ready';
    refreshButton.disabled = false;
    refreshButton.classList.remove('is-loading');
    refreshButton.textContent = 'Refresh on-chain data';
    startArchiveStream();
    if (cached.source !== 'api') void refreshChainArchives({ background: true });
  } catch (error) {
    console.warn('Archive cache unavailable; falling back to Sui Mainnet', error);
    startArchiveStream();
    await refreshChainArchives();
  }
}

refreshButton.addEventListener('click', () => refreshChainArchives());
window.refreshChainArchives = refreshChainArchives;
void initializeArchives();
