import heic2any from 'heic2any';

function isHeicFile(fileOrUrl, type = '') {
  const value = typeof fileOrUrl === 'string' ? fileOrUrl : (fileOrUrl?.name || '');
  return /\.(heic|heif)(?:$|[?#])/i.test(value) || /image\/hei[cf]/i.test(type || (fileOrUrl?.type || ''));
}

async function convertHeicBlob(blob) {
  const converted = await heic2any({ blob, toType: 'image/jpeg', quality: 0.92 });
  return Array.isArray(converted) ? converted[0] : converted;
}

window.theArchiveHeicSupport = {
  isHeicFile,
  async convertFile(file) {
    if (!isHeicFile(file)) return file;
    return convertHeicBlob(file);
  },
  async loadUrl(url) {
    const response = await fetch(url, { mode: 'cors' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const blob = await response.blob();
    if (!isHeicFile(url, blob.type)) return blob;
    return convertHeicBlob(blob);
  }
};
