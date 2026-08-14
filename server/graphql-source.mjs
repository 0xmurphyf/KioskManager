const EVENTS_QUERY = `
  query ArchiveEvents($cursor: String, $eventType: String!) {
    events(first: 50, after: $cursor, filter: { type: $eventType }) {
      nodes {
        contents { json }
        timestamp
        transaction { digest }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;

const OBJECT_QUERY = `
  query ArchiveObject($address: SuiAddress!) {
    object(address: $address) {
      address
      version
      digest
      asMoveObject { contents { json type { repr } } }
    }
  }
`;

export class GraphqlArchiveSource {
  constructor({ endpoint, eventType, fetchImpl = fetch, timeoutMs = 15_000 }) {
    this.endpoint = endpoint;
    this.eventType = eventType;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  async query(query, variables, signal) {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    const response = await this.fetch(this.endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      signal: combined,
    });
    if (!response.ok) throw new Error(`Sui GraphQL returned HTTP ${response.status}`);
    const body = await response.json();
    if (body.errors?.length) {
      throw new Error(body.errors.map((error) => error.message).join('; '));
    }
    return body.data;
  }

  async listEventPage(cursor = null, signal) {
    const data = await this.query(
      EVENTS_QUERY,
      { cursor, eventType: this.eventType },
      signal,
    );
    return {
      events: data?.events?.nodes || [],
      cursor: data?.events?.pageInfo?.endCursor || cursor,
      hasNextPage: Boolean(data?.events?.pageInfo?.hasNextPage),
    };
  }

  async getObject(archiveId, signal) {
    const data = await this.query(OBJECT_QUERY, { address: archiveId }, signal);
    return data?.object || null;
  }
}
