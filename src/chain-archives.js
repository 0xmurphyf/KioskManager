export const PACKAGE_ID = '0x639d824b6a4de1b1491d69eaa79597336ab3be8dc9dff3bfd78cd333bf38a53b';
export const EVENT_TYPE = `${PACKAGE_ID}::memory_archive::MemoryArchived`;
export const GRAPHQL_ENDPOINT = 'https://graphql.testnet.sui.io/graphql';

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
      asMoveObject {
        contents { json }
      }
    }
  }
`;

async function graphql(query, variables) {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Testnet index returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(body.errors[0].message || 'Testnet index query failed');
  return body.data;
}

function valueOf(object, ...names) {
  for (const name of names) {
    if (object?.[name] !== undefined && object?.[name] !== null) return object[name];
  }
  return '';
}

function parseEvent(event) {
  const eventJson = event.contents?.json;
  const raw = typeof eventJson === 'string' ? JSON.parse(eventJson) : eventJson;
  return {
    archiveId: valueOf(raw, 'archive_id', 'archiveId'),
    originalObjectId: valueOf(raw, 'original_object_id', 'originalObjectId'),
    archivedBy: valueOf(raw, 'archived_by', 'archivedBy'),
    archivedAtMs: Number(valueOf(raw, 'archived_at_ms', 'archivedAtMs') || event.timestamp || 0),
    policyVersion: valueOf(raw, 'policy_version', 'policyVersion'),
    transactionDigest: event.transaction?.digest || '',
  };
}

async function enrichArchive(event) {
  const data = await graphql(OBJECT_QUERY, { address: event.archiveId });
  const object = data.object;
  const contents = object?.asMoveObject?.contents?.json || {};
  return {
    ...event,
    objectVersion: object?.version || '',
    objectDigest: object?.digest || '',
    content: contents,
  };
}

export async function scanArchives() {
  const events = [];
  let cursor = null;
  do {
    const data = await graphql(EVENTS_QUERY, { cursor, eventType: EVENT_TYPE });
    events.push(...data.events.nodes.map(parseEvent));
    cursor = data.events.pageInfo.hasNextPage ? data.events.pageInfo.endCursor : null;
  } while (cursor);

  const archives = await Promise.all(events.map(enrichArchive));
  return archives.sort((a, b) => b.archivedAtMs - a.archivedAtMs);
}
