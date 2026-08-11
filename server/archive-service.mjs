import { setTimeout as sleep } from 'node:timers/promises';
import { enrichArchive, normalizeArchiveEvent } from './archive-data.mjs';

export class ArchiveEvents {
  constructor() {
    this.listeners = new Set();
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(archive) {
    for (const listener of this.listeners) listener(archive);
  }
}

export class ArchiveService {
  constructor({
    store,
    source,
    events,
    eventType,
    logger = console,
    retryCount = 8,
    retryBaseMs = 750,
    sleepImpl = sleep,
    now = () => new Date(),
  }) {
    this.store = store;
    this.source = source;
    this.events = events;
    this.eventType = eventType;
    this.logger = logger;
    this.retryCount = retryCount;
    this.retryBaseMs = retryBaseMs;
    this.sleep = sleepImpl;
    this.now = now;
    this.pending = new Map();
    this.reconcilePromise = null;
  }

  ingest(rawEvent, { signal } = {}) {
    const normalized = normalizeArchiveEvent(rawEvent, this.eventType);
    const existing = this.pending.get(normalized.archiveId);
    if (existing) return existing;

    const operation = this.#ingestNormalized(normalized, signal).finally(() => {
      this.pending.delete(normalized.archiveId);
    });
    this.pending.set(normalized.archiveId, operation);
    return operation;
  }

  async #ingestNormalized(event, signal) {
    let object = null;
    let lastError = null;
    for (let attempt = 0; attempt < this.retryCount; attempt += 1) {
      if (signal?.aborted) throw signal.reason;
      try {
        object = await this.source.getObject(event.archiveId, signal);
        if (object) break;
        lastError = new Error(`Object ${event.archiveId} is not indexed yet`);
      } catch (error) {
        lastError = error;
      }
      if (attempt + 1 < this.retryCount) {
        await this.sleep(Math.min(this.retryBaseMs * 2 ** attempt, 10_000), undefined, {
          signal,
        });
      }
    }
    if (!object) throw lastError || new Error(`Unable to load object ${event.archiveId}`);

    const cachedAt = this.now().toISOString();
    const archive = enrichArchive(event, object, cachedAt);
    const result = this.store.upsertArchive(archive, cachedAt);
    this.store.setMeta('generatedAt', cachedAt);
    if (result.inserted) this.events.publish(archive);
    return result;
  }

  reconcile({ full = false, signal } = {}) {
    if (this.reconcilePromise) return this.reconcilePromise;
    this.reconcilePromise = this.#reconcile({ full, signal }).finally(() => {
      this.reconcilePromise = null;
    });
    return this.reconcilePromise;
  }

  async #reconcile({ full, signal }) {
    let cursor = full ? null : this.store.getMeta('graphqlCursor');
    let processed = 0;

    while (true) {
      const page = await this.source.listEventPage(cursor, signal);
      for (const rawEvent of page.events) {
        await this.ingest(rawEvent, { signal });
        processed += 1;
      }
      if (page.cursor) {
        cursor = page.cursor;
        this.store.setMeta('graphqlCursor', cursor);
      }
      if (!page.hasNextPage) break;
      if (!page.cursor) throw new Error('GraphQL pagination did not return an end cursor');
    }

    const completedAt = this.now().toISOString();
    this.store.setMeta('lastReconciledAt', completedAt);
    this.store.setMeta('generatedAt', completedAt);
    this.logger.info?.(`[archive] reconciliation complete (${processed} event(s))`);
    return { processed, cursor, completedAt };
  }
}
