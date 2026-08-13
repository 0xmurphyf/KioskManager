function protobufValue(value) {
  const kind = value?.kind;
  if (!kind || typeof kind !== 'object' || !('oneofKind' in kind)) return value;
  switch (kind.oneofKind) {
    case 'nullValue':
      return null;
    case 'numberValue':
      return kind.numberValue;
    case 'stringValue':
      return kind.stringValue;
    case 'boolValue':
      return kind.boolValue;
    case 'structValue':
      return Object.fromEntries(
        Object.entries(kind.structValue?.fields || {}).map(([key, item]) => [
          key,
          protobufValue(item),
        ]),
      );
    case 'listValue':
      return (kind.listValue?.values || []).map(protobufValue);
    default:
      return null;
  }
}

function jsonValue(value) {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return value;
    }
  }
  return protobufValue(value);
}

function valueOf(object, ...names) {
  for (const name of names) {
    if (object?.[name] !== undefined && object?.[name] !== null) return object[name];
  }
  return '';
}

function timestampMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  if (value?.seconds !== undefined) {
    return Number(value.seconds) * 1000 + Math.floor(Number(value.nanos || 0) / 1_000_000);
  }
  const parsed = Date.parse(value || '');
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function normalizeArchiveEvent(rawEvent, expectedEventType = '') {
  const event = rawEvent?.event || rawEvent;
  const payload =
    jsonValue(event?.json ?? event?.contents?.json ?? event?.contentsJson) || {};
  const archiveId = String(valueOf(payload, 'archive_id', 'archiveId'));
  if (!archiveId) throw new Error('MemoryArchived event is missing archive_id');

  return {
    archiveId,
    originalObjectId: String(valueOf(payload, 'original_object_id', 'originalObjectId')),
    archivedBy: String(
      valueOf(payload, 'archived_by', 'archivedBy') || event?.sender || '',
    ),
    archivedAtMs: timestampMs(
      valueOf(payload, 'archived_at_ms', 'archivedAtMs') ||
        event?.timestamp ||
        rawEvent?.timestamp,
    ),
    storageType: Number(valueOf(payload, 'storage_type', 'storageType') || 0),
    sourceType: Number(valueOf(payload, 'source_type', 'sourceType') || 0),
    artifactId: String(valueOf(payload, 'artifact_id', 'artifactId')),
    transactionDigest: String(
      event?.transactionDigest ||
        rawEvent?.transactionDigest ||
        rawEvent?.transaction?.digest ||
        '',
    ),
    checkpoint: String(event?.checkpoint ?? rawEvent?.checkpoint ?? ''),
    eventType: String(event?.eventType || rawEvent?.eventType || expectedEventType),
  };
}

export function enrichArchive(event, object, cachedAt = new Date().toISOString()) {
  const content =
    jsonValue(object?.asMoveObject?.contents?.json ?? object?.content ?? object?.json) || {};
  return {
    ...event,
    objectVersion: String(object?.version ?? ''),
    objectDigest: String(object?.digest ?? ''),
    content,
    cachedAt,
  };
}
