import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArchiveEvents } from './archive-service.mjs';
import { ArchiveStore } from './database.mjs';
import { createArchiveHttpServer } from './http-server.mjs';

test('HTTP server returns the cache envelope and serves the SPA', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'archive-server-'));
  await writeFile(join(directory, 'index.html'), '<h1>The Archive</h1>');
  const store = new ArchiveStore(':memory:');
  store.upsertArchive({ archiveId: '0x1', archivedAtMs: 1, transactionDigest: 'tx' });
  store.setMeta('generatedAt', '2026-08-11T00:00:00.000Z');
  const server = createArchiveHttpServer({
    store,
    events: new ArchiveEvents(),
    packageId: '0xpkg',
    eventType: '0xpkg::memory_archive::MemoryArchived',
    staticDir: directory,
    corsOrigin: 'https://archive.example',
    health: () => ({ listener: { mode: 'events' } }),
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/archives`, {
    headers: { Origin: 'https://archive.example' },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://archive.example');
  assert.deepEqual(await response.json(), {
    archives: [{ archiveId: '0x1', archivedAtMs: 1, transactionDigest: 'tx' }],
    generatedAt: '2026-08-11T00:00:00.000Z',
    packageId: '0xpkg',
    eventType: '0xpkg::memory_archive::MemoryArchived',
  });

  const page = await fetch(`http://127.0.0.1:${port}/unknown/route`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /The Archive/);

  const health = await fetch(`http://127.0.0.1:${port}/api/health`);
  assert.equal((await health.json()).listener.mode, 'events');
});

test('HTTP server accepts an image upload and serves it back', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'archive-uploads-'));
  const uploads = join(directory, 'uploads');
  const store = new ArchiveStore(':memory:');
  const server = createArchiveHttpServer({
    store,
    events: new ArchiveEvents(),
    packageId: '0xpkg',
    eventType: '0xpkg::memory_archive::MemoryArchived',
    staticDir: directory,
    uploadsDir: uploads,
    publicBaseUrl: 'https://archive.example',
    maxUploadBytes: 1024,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { port } = server.address();
  const payload = Buffer.from('fake-png-bytes');
  const response = await fetch(`http://127.0.0.1:${port}/api/uploads`, {
    method: 'POST',
    headers: { 'content-type': 'image/png', 'content-length': String(payload.length) },
    body: payload,
  });
  assert.equal(response.status, 201);
  const uploaded = await response.json();
  assert.match(uploaded.url, /^https:\/\/archive\.example\/media\/[0-9a-f-]+\.png$/);
  const filename = uploaded.url.split('/').pop();
  assert.deepEqual(await readFile(join(uploads, filename)), payload);
  const served = await fetch(`http://127.0.0.1:${port}/media/${filename}`);
  assert.equal(served.status, 200);
  assert.equal(await served.text(), payload.toString());
});
