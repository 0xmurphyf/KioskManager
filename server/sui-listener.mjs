import { setTimeout as sleep } from 'node:timers/promises';

const EVENT_READ_MASK = [
  'package_id',
  'module',
  'sender',
  'event_type',
  'contents',
  'json',
  'checkpoint',
  'transaction_digest',
  'transaction_index',
  'event_index',
];

const CHECKPOINT_READ_MASK = [
  'sequence_number',
  'transactions.digest',
  'transactions.checkpoint',
  'transactions.timestamp',
  'transactions.events.events.package_id',
  'transactions.events.events.module',
  'transactions.events.events.sender',
  'transactions.events.events.event_type',
  'transactions.events.events.contents',
  'transactions.events.events.json',
];

function exactEventFilter(eventType) {
  return {
    terms: [
      {
        literals: [
          {
            negated: false,
            predicate: {
              oneofKind: 'eventType',
              eventType: { eventType },
            },
          },
        ],
      },
    ],
  };
}

function isUnimplemented(error) {
  return (
    error?.code === 12 ||
    /unimplemented|unknown method|subscribeevents is not a function/i.test(
      String(error?.message || error),
    )
  );
}

export async function createSuiGrpcClient(baseUrl) {
  const { SuiGrpcClient } = await import('@mysten/sui/grpc');
  return new SuiGrpcClient({ network: 'testnet', baseUrl });
}

export class SuiArchiveListener {
  constructor({
    baseUrl,
    eventType,
    onEvent,
    beforeReconnect,
    onConnected,
    clientFactory = createSuiGrpcClient,
    logger = console,
    reconnectBaseMs = 1_000,
    reconnectMaxMs = 30_000,
    sleepImpl = sleep,
  }) {
    this.baseUrl = baseUrl;
    this.eventType = eventType;
    this.onEvent = onEvent;
    this.beforeReconnect = beforeReconnect;
    this.onConnected = onConnected;
    this.clientFactory = clientFactory;
    this.logger = logger;
    this.reconnectBaseMs = reconnectBaseMs;
    this.reconnectMaxMs = reconnectMaxMs;
    this.sleep = sleepImpl;
    this.disableEventSubscription = false;
    this.state = {
      connected: false,
      mode: 'starting',
      reconnects: 0,
      lastEventAt: null,
      lastError: null,
    };
  }

  status() {
    return { ...this.state };
  }

  async run(signal) {
    let failures = 0;
    while (!signal.aborted) {
      try {
        if (failures > 0 && this.beforeReconnect) {
          void Promise.resolve(this.beforeReconnect(signal)).catch((error) => {
            this.logger.error?.(
              `[archive] gap reconciliation failed: ${String(error?.message || error)}`,
            );
          });
        }
        const client = await this.clientFactory(this.baseUrl);
        await this.#consume(client, signal);
        if (!signal.aborted) throw new Error('Sui subscription ended unexpectedly');
      } catch (error) {
        if (signal.aborted) break;
        failures += 1;
        this.state.connected = false;
        this.state.reconnects += 1;
        this.state.lastError = String(error?.message || error);
        this.logger.error?.(`[archive] Sui subscription error: ${this.state.lastError}`);
        const delay = Math.min(
          this.reconnectBaseMs * 2 ** Math.min(failures - 1, 8),
          this.reconnectMaxMs,
        );
        await this.sleep(delay, undefined, { signal }).catch(() => {});
      }
    }
    this.state.connected = false;
    this.state.mode = 'stopped';
  }

  async #consume(client, signal) {
    if (!this.disableEventSubscription && client.subscriptionService?.subscribeEvents) {
      try {
        await this.#consumeEvents(client, signal);
        return;
      } catch (error) {
        if (!isUnimplemented(error)) throw error;
        this.disableEventSubscription = true;
        this.logger.warn?.(
          '[archive] SubscribeEvents unavailable; falling back to checkpoint stream',
        );
      }
    }
    await this.#consumeCheckpoints(client, signal);
  }

  async #consumeEvents(client, signal) {
    const call = client.subscriptionService.subscribeEvents(
      {
        readMask: { paths: EVENT_READ_MASK },
        filter: exactEventFilter(this.eventType),
      },
      { abort: signal },
    );
    this.state.connected = false;
    this.state.mode = 'connecting-events';
    this.state.lastError = null;

    let connected = false;
    for await (const frame of call.responses) {
      if (!connected) {
        connected = true;
        this.#markConnected('events', signal);
      }
      if (!frame.event) continue;
      if (String(frame.event.eventType).toLowerCase() !== this.eventType.toLowerCase()) continue;
      await this.onEvent(frame.event, signal);
      this.state.lastEventAt = new Date().toISOString();
    }
  }

  async #consumeCheckpoints(client, signal) {
    const subscribe = client.subscriptionService?.subscribeCheckpoints;
    if (!subscribe) throw new Error('Sui gRPC subscription service is unavailable');
    const call = subscribe.call(
      client.subscriptionService,
      {
        readMask: { paths: CHECKPOINT_READ_MASK },
        filter: exactEventFilter(this.eventType),
      },
      { abort: signal },
    );
    this.state.connected = false;
    this.state.mode = 'connecting-checkpoints';
    this.state.lastError = null;

    let connected = false;
    for await (const frame of call.responses) {
      if (!connected) {
        connected = true;
        this.#markConnected('checkpoints', signal);
      }
      for (const transaction of frame.checkpoint?.transactions || []) {
        for (const event of transaction.events?.events || []) {
          if (String(event.eventType).toLowerCase() !== this.eventType.toLowerCase()) continue;
          await this.onEvent(
            {
              ...event,
              checkpoint: transaction.checkpoint ?? frame.cursor,
              transactionDigest: transaction.digest,
              timestamp: transaction.timestamp,
            },
            signal,
          );
          this.state.lastEventAt = new Date().toISOString();
        }
      }
    }
  }

  #markConnected(mode, signal) {
    this.state.connected = true;
    this.state.mode = mode;
    if (!this.onConnected) return;
    void Promise.resolve(this.onConnected({ mode, signal })).catch((error) => {
      this.logger.error?.(
        `[archive] post-connect reconciliation failed: ${String(error?.message || error)}`,
      );
    });
  }
}
