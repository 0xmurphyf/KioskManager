// Client-side Arweave upload for The Archive's "Independent Storage" (Arweave) option.
//
// Arweave transactions must be signed by an Arweave wallet (RSA key). The user only
// connects a Sui wallet in this dApp, so we generate an ephemeral Arweave wallet in
// the browser, persist it in localStorage, and use it to upload. No third-party API
// key is required — we talk directly to the public gateway at https://arweave.net.
//
// The returned transaction id is 32 bytes (base64url). The contract expects exactly
// 32 bytes for hero_image_hash, so the txid maps perfectly. The uri is
// https://arweave.net/<txid>.
//
// NOTE: real Arweave mainnet uploads cost a tiny amount of AR. This module is
// code-complete and builds cleanly; a live upload requires the generated wallet to
// hold a small AR balance.

import Arweave from 'arweave';

const GATEWAY = 'https://arweave.net';
const STORAGE_KEY = 'thearchive:arweave-wallet';

const arweave = Arweave.init({ host: 'arweave.net', port: 443, protocol: 'https' });

// Load the persisted wallet, or generate + persist a new ephemeral one.
export async function getArweaveWallet() {
  let jwk = null;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) jwk = JSON.parse(raw);
  } catch {
    jwk = null;
  }
  if (!jwk) {
    jwk = await arweave.wallets.generate();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(jwk));
    } catch {
      /* ignore quota errors; the wallet survives for this session only */
    }
  }
  return jwk;
}

// Convert an Arweave base64url transaction id into a 32-byte array, as required
// by the contract's hero_image_hash field.
export function arweaveTxIdToBytes(id) {
  const b64 = id.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return Array.from(bytes);
}

// Upload raw bytes to Arweave and return { id, uri }.
// `data` is a Uint8Array/ArrayBuffer; `contentType` is the upload's content-type.
export async function uploadToArweave(data, contentType = 'application/octet-stream') {
  const jwk = await getArweaveWallet();
  const buf = data instanceof Uint8Array ? data : new Uint8Array(data);

  const tx = await arweave.createTransaction({ data: buf, reward: '0' }, jwk);
  tx.addTag('Content-Type', contentType);
  tx.addTag('App', 'the-archive');
  await arweave.transactions.sign(tx, jwk);

  const postRes = await fetch(`${GATEWAY}/tx`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(tx),
  });
  if (!postRes.ok) {
    throw new Error(`Arweave tx submit failed: ${postRes.status}`);
  }
  // Upload the data chunk.
  const chunkRes = await fetch(`${GATEWAY}/chunk/${tx.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream' },
    body: buf,
  });
  if (!chunkRes.ok) {
    throw new Error(`Arweave chunk upload failed: ${chunkRes.status}`);
  }
  return { id: tx.id, uri: `${GATEWAY}/${tx.id}`, hashBytes: arweaveTxIdToBytes(tx.id) };
}

// Fetch a URL's bytes (best-effort; CORS may block). Returns Uint8Array or null.
export async function fetchBytes(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return new Uint8Array(await res.arrayBuffer());
  } catch {
    return null;
  }
}

// Upload the hero asset for an archive entry. Prefers the object's display image;
// if that cannot be fetched (CORS / missing), falls back to a small metadata JSON
// so the on-chain record still gets a valid Arweave uri + 32-byte hash.
export async function uploadHero({ imageUrl, objectId, type }) {
  let payload = null;
  let contentType = 'application/octet-stream';
  if (imageUrl) {
    const bytes = await fetchBytes(imageUrl);
    if (bytes) {
      payload = bytes;
      contentType = 'image/*';
    }
  }
  if (!payload) {
    const meta = JSON.stringify({ kind: 'archive-hero', objectId, type, note: 'original image unavailable' });
    payload = new TextEncoder().encode(meta);
    contentType = 'application/json';
  }
  return uploadToArweave(payload, contentType);
}

window.theArchiveArweave = { getArweaveWallet, uploadToArweave, uploadHero, arweaveTxIdToBytes };
