import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SuiArchiveListener } from './sui-listener.mjs';

const EVENT_TYPE = '0xpkg::memory_archive::MemoryArchived';

test('SubscribeEvents uses the exact event type filter', async () => {
  const controller = new AbortController();
  let request;
  let delivered;
  const client = {
    subscriptionService: {
      subscribeEvents(input) {
        request = input;
        return {
          responses: (async function* () {
            yield { watermark: { checkpoint: 10n } };
            yield {
              event: {
                eventType: EVENT_TYPE,
                json: { archive_id: '0x1' },
              },
            };
          })(),
        };
      },
    },
  };
  const listener = new SuiArchiveListener({
    baseUrl: 'unused',
    eventType: EVENT_TYPE,
    clientFactory: async () => client,
    onEvent: async (event) => {
      delivered = event;
      controller.abort();
    },
    logger: { error() {}, warn() {} },
  });

  await listener.run(controller.signal);
  assert.equal(delivered.eventType, EVENT_TYPE);
  assert.equal(
    request.filter.terms[0].literals[0].predicate.eventType.eventType,
    EVENT_TYPE,
  );
  assert.ok(request.readMask.paths.includes('transaction_digest'));
});

test('checkpoint fallback filters unrelated events', async () => {
  const controller = new AbortController();
  const delivered = [];
  let request;
  const client = {
    subscriptionService: {
      subscribeCheckpoints(input) {
        request = input;
        return {
          responses: (async function* () {
            yield {
              cursor: 42n,
              checkpoint: {
                transactions: [
                  {
                    digest: 'tx',
                    events: {
                      events: [
                        { eventType: '0xother::module::Event' },
                        { eventType: EVENT_TYPE, json: { archive_id: '0x2' } },
                      ],
                    },
                  },
                ],
              },
            };
          })(),
        };
      },
    },
  };
  const listener = new SuiArchiveListener({
    baseUrl: 'unused',
    eventType: EVENT_TYPE,
    clientFactory: async () => client,
    onEvent: async (event) => {
      delivered.push(event);
      controller.abort();
    },
    logger: { error() {}, warn() {} },
  });

  await listener.run(controller.signal);
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].transactionDigest, 'tx');
  assert.equal(delivered[0].checkpoint, 42n);
  assert.equal(
    request.filter.terms[0].literals[0].predicate.eventType.eventType,
    EVENT_TYPE,
  );
  assert.ok(request.readMask.paths.includes('transactions.events.events.json'));
  assert.ok(!request.readMask.paths.some((path) => path.startsWith('checkpoint.')));
});
