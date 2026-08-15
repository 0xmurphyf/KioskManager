const DEFAULT_ENDPOINT = 'https://graphql.tradeport.gg/';
const DEFAULT_API_USER = 'tradeport.xyz';
// TradePort exposes these headers in its public web client. They are only used for
// read-only discovery; deployments can override them with environment variables.
const DEFAULT_API_KEY = '7cJ09MM.9c8d37fc6e5fad1cf0823c68657cabdd';

const KIOSKS_QUERY = `
  query WalletKiosks($wallet: String!) {
    sui {
      kiosks: kiosks_by_owner_address(owner_address: $wallet) {
        id
        is_origin_byte
        is_personal
        owner_address
        is_shared
      }
    }
  }
`;

const NFT_QUERY = `
  query WalletNfts($where: nfts_bool_exp!, $limit: Int!, $offset: Int!) {
    sui {
      nfts(where: $where, limit: $limit, offset: $offset) {
        token_id
        name
        media_url
        media_type
        owner
        delegated_owner
        chain_state
        burned
        staked
        claimable
        collection {
          id
          title
          slug
          semantic_slug
          cover_url
        }
      }
    }
  }
`;

function normalizeAddress(address) {
  const value = String(address || '').trim().toLowerCase();
  return /^0x[0-9a-f]{1,64}$/.test(value) ? value : '';
}

function kioskObjectToOwnedObject(nft, wallet = '') {
  const state = nft?.chain_state || {};
  const type = state?.bcs?.type || state?.type || '';
  const objectId = nft?.token_id || '';
  if (!objectId || !type) return null;
  return {
    objectId,
    type,
    objectType: type,
    version: state?.bcs?.version,
    name: nft.name || objectId,
    imageUrl: nft.media_url || '',
    isCoin: false,
    ownerObjectId: (nft.delegated_owner || nft.owner) && normalizeAddress(nft.delegated_owner || nft.owner) !== normalizeAddress(wallet) && normalizeAddress(nft.delegated_owner || nft.owner) !== normalizeAddress(state.kiosk_id) ? normalizeAddress(nft.delegated_owner || nft.owner) : '',
    json: { id: objectId, name: nft.name || '' },
    display: {
      output: {
        name: nft.name || objectId,
        image_url: nft.media_url || '',
        description: '',
      },
    },
    indexer: {
      owner: nft.owner || '',
      delegatedOwner: nft.delegated_owner || '',
      kioskId: state.kiosk_id || '',
      collection: nft.collection || null,
      mediaType: nft.media_type || '',
      burned: Boolean(nft.burned),
      staked: Boolean(nft.staked),
      claimable: Boolean(nft.claimable),
    },
  };
}

export function createOwnedObjectIndexer({
  endpoint = DEFAULT_ENDPOINT,
  apiUser = DEFAULT_API_USER,
  apiKey = DEFAULT_API_KEY,
  timeoutMs = 15_000,
  pageSize = 100,
} = {}) {
  async function request(query, variables, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-user': apiUser,
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`NFT indexer returned HTTP ${response.status}`);
      const body = await response.json();
      if (body.errors?.length) throw new Error(body.errors[0].message || 'NFT indexer query failed');
      return body.data?.sui || {};
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
    }
  }

  async function queryNfts(where, signal) {
    const result = [];
    for (let offset = 0; ; offset += pageSize) {
      const page = await request(NFT_QUERY, { where, limit: pageSize, offset }, signal);
      const nfts = page.nfts || [];
      result.push(...nfts);
      if (nfts.length < pageSize) break;
    }
    return result;
  }

  return async function scan(address, { signal } = {}) {
    const wallet = normalizeAddress(address);
    if (!wallet) throw new Error('A valid Sui wallet address is required');

    const kioskData = await request(KIOSKS_QUERY, { wallet }, signal);
    const kiosks = kioskData.kiosks || [];
    const kioskIds = kiosks.map((kiosk) => kiosk.id).filter(Boolean);
    const nftRows = [];

    nftRows.push(
      ...(await queryNfts({
        _or: [
          { owner: { _eq: wallet } },
          { delegated_owner: { _eq: wallet } },
        ],
      }, signal)),
    );

    for (const kioskId of kioskIds) {
      nftRows.push(
        ...(await queryNfts({
          chain_state: { _contains: { kiosk_id: kioskId } },
        }, signal)),
      );
    }

    const objects = new Map();
    for (const row of nftRows) {
      const object = kioskObjectToOwnedObject(row, wallet);
      if (object && !object.indexer.burned) objects.set(object.objectId, object);
    }
    return {
      source: 'tradeport-indexer',
      wallet,
      kiosks,
      objects: [...objects.values()],
    };
  };
}
