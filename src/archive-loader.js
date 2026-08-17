let archivePromise;
let heicPromise;

export function loadArchiveModules() {
  if (!archivePromise) {
    archivePromise = import('./archive-tx.js').catch((error) => {
      archivePromise = undefined;
      throw error;
    });
  }
  return archivePromise;
}

export function loadHeicSupport() {
  if (!heicPromise) {
    heicPromise = import('./heic-support.js').catch((error) => {
      heicPromise = undefined;
      throw error;
    });
  }
  return heicPromise;
}

window.theArchiveModuleLoader = {
  loadArchiveModules,
  loadHeicSupport,
};
