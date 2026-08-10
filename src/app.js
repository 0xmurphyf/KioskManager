import './wallet.js';
import { EVENT_TYPE, PACKAGE_ID, scanArchives } from './chain-archives.js';

const status = document.getElementById('archiveScanStatus');
const refreshButton = document.getElementById('scanArchivesBtn');

async function refreshChainArchives() {
  refreshButton.disabled = true;
  refreshButton.textContent = 'Scanning Testnet…';
  status.textContent = 'Reading MemoryArchived events and their immutable objects…';
  status.className = 'scan-status loading';

  try {
    const archives = await scanArchives();
    window.renderChainArchives(archives, { packageId: PACKAGE_ID, eventType: EVENT_TYPE });
    status.textContent = `${archives.length} immutable archive${archives.length === 1 ? '' : 's'} indexed from Sui Testnet.`;
    status.className = 'scan-status ready';
  } catch (error) {
    console.error('Could not scan archive events', error);
    window.renderChainArchiveError(error);
    status.textContent = `Unable to read Testnet: ${error.message}`;
    status.className = 'scan-status error';
  } finally {
    refreshButton.disabled = false;
    refreshButton.textContent = 'Refresh on-chain data';
  }
}

refreshButton.addEventListener('click', refreshChainArchives);
window.refreshChainArchives = refreshChainArchives;
refreshChainArchives();
