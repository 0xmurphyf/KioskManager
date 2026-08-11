import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ArchiveEvents, ArchiveService } from './archive-service.mjs';
import { ArchiveStore } from './database.mjs';

function event(id, time) {
  return {
    contents: {
      json: {
        archive_id: id,
        original_object_id: `${id}-original`,
        archived_by: '0xsender',
        archived_at_ms: String(time),
        policy_version: '1',
      },
    },
    transaction: { digest: `${id}-transaction` },
  };
}

test('reconciliation persists archives idempotently and broadcasts only inserts', async (t) => {
  const store = new ArchiveStore(':memory:');
  t.after(() => store.close());
  const pages = new Map([
    [null, { events: [event('0xa', 100)], cursor: 'page-1', hasNextPage: true }],
    ['page-1', { events: [event('0xb', 200)], cursor: 'page-2', hasNextPage: false }],
    ['page-2', { events: [], cursor: 'page-2', hasNextPage: false }],
  ]);
  const source = {
    listEventPage: async (cursor) => pages.get(cursor) || pages.get(null),
    getObject: async (archiveId) => ({
      version: '1',
      digest: `${archiveId}-digest`,
      asMoveObject: { contents: { json: { message: `memory ${archiveId}` } } },
    }),
  };
  const events = new ArchiveEvents();
  const published = [];
  events.subscribe((archive) => published.push(archive.archiveId));
  const service = new ArchiveService({
    store,
    source,
    events,
    eventType: '0xpkg::memory_archive::MemoryArchived',
    retryCount: 1,
    now: () => new Date('2026-08-11T00:00:00.000Z'),
  });

  const first = await service.reconcile({ full: true });
  assert.equal(first.processed, 2);
  assert.deepEqual(store.listArchives().map((archive) => archive.archiveId), ['0xb', '0xa']);
  assert.deepEqual(published, ['0xa', '0xb']);
  assert.equal(store.getMeta('graphqlCursor'), 'page-2');

  const second = await service.reconcile();
  assert.equal(second.processed, 0);
  assert.equal(store.countArchives(), 2);
  assert.deepEqual(published, ['0xa', '0xb']);
});

test('archive_id is the SQLite idempotency key', (t) => {
  const store = new ArchiveStore(':memory:');
  t.after(() => store.close());
  const original = { archiveId: '0x1', archivedAtMs: 1, transactionDigest: 'tx' };
  assert.equal(store.upsertArchive(original).inserted, true);
  assert.equal(store.upsertArchive({ ...original, objectDigest: 'new' }).inserted, false);
  assert.equal(store.countArchives(), 1);
  assert.equal(store.getArchive('0x1').objectDigest, 'new');
});
