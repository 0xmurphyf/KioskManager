import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ArchiveStore } from './database.mjs';
import { createArchiveHttpServer } from './http-server.mjs';

function makeServer(directory, store, extra = {}) {
  return createArchiveHttpServer({
    store,
    events: { subscribe() {}, publish() {} },
    packageId: '0xpkg',
    eventType: '0xpkg::memory_archive::MemoryArchived',
    staticDir: directory,
    corsOrigin: '*',
    health: () => ({ listener: { mode: 'events' } }),
    ...extra,
  });
}

test('SSRF: private/metadata hosts are blocked by /api/image-hash', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'ssrf-'));
  const store = new ArchiveStore(':memory:');
  const server = makeServer(directory, store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { port } = server.address();

  const blocked = [
    'http://169.254.169.254/latest/meta-data/',
    'http://127.0.0.1:8080/x.png',
    'http://10.0.0.5/y.png',
    'http://192.168.1.1/z.png',
    'http://172.16.0.1/q.png',
    'http://localhost/secret.png',
  ];
  for (const url of blocked) {
    const res = await fetch(`http://127.0.0.1:${port}/api/image-hash?url=${encodeURIComponent(url)}`);
    assert.equal(res.status, 502, `expected ${url} to be blocked, got ${res.status}`);
  }
});

test('/api/archives supports cursor pagination', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'page-'));
  const store = new ArchiveStore(':memory:');
  const archives = [
    { archiveId: '0x03', archivedAtMs: 300, transactionDigest: 'c' },
    { archiveId: '0x02', archivedAtMs: 200, transactionDigest: 'b' },
    { archiveId: '0x01', archivedAtMs: 100, transactionDigest: 'a' },
  ];
  for (const a of archives) store.upsertArchive(a);
  const server = makeServer(directory, store);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(async () => {
    await new Promise((r) => server.close(r));
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { port } = server.address();

  const first = await (await fetch(`http://127.0.0.1:${port}/api/archives?limit=2`)).json();
  assert.deepEqual(first.archives.map((a) => a.archiveId), ['0x03', '0x02']);
  assert.ok(first.nextCursor, 'expected a nextCursor when the page is full');

  const second = await (
    await fetch(`http://127.0.0.1:${port}/api/archives?limit=2&cursor=${first.nextCursor}`)
  ).json();
  assert.deepEqual(second.archives.map((a) => a.archiveId), ['0x01']);
  assert.equal(second.nextCursor, null, 'expected no nextCursor on the last page');

  // Backward-compatible: no limit returns everything.
  const all = await (await fetch(`http://127.0.0.1:${port}/api/archives`)).json();
  assert.deepEqual(all.archives.map((a) => a.archiveId), ['0x03', '0x02', '0x01']);
  assert.equal(all.nextCursor, undefined);
});
