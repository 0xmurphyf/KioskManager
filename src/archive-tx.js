// Real Sui Mainnet archival flow.
//
// This module replaces the previous simulated archiving with an actual on-chain
// call to `memory_archive::archive_forever`. Once an object is archived it is
// frozen forever (transfer::freeze_object) and can never be moved, edited, or
// recovered — so every UI path that calls this must warn the user first.

import { Transaction } from '@mysten/sui/transactions';
import { PACKAGE_ID } from './chain-archives.js';

const GRAPHQL_ENDPOINT = 'https://graphql.mainnet.sui.io/graphql';

// Enumerate the dynamic object fields (i.e. items) of a Kiosk object. Kiosk items
// are stored as dynamic fields on the Kiosk object keyed by item object id.
const KIOSK_FIELDS_QUERY = `
  query KioskFields($id: SuiAddress!, $cursor: String) {
    object(address: $id) {
      dynamicFields(first: 50, after: $cursor) {
        nodes {
          name { type { repr } json }
          value { ... on MoveObject { address } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

function objectIdValue(value){
  if(typeof value==='string')return value;
  if(!value||typeof value!=='object')return '';
  return objectIdValue(value.id||value.ID||value.address||value.objectId||value.object_id);
}

async function graphqlFetch(query, variables) {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
  if (!response.ok) throw new Error(`Mainnet GraphQL returned HTTP ${response.status}`);
  const body = await response.json();
  if (body.errors?.length) throw new Error(body.errors[0].message || 'Mainnet GraphQL query failed');
  return body.data;
}

const POLICY_OBJECT_ID =
  '0xfd3a6fd05d9f30f0cac49f133445e13dea730206d5d87bcf4e5890c5b89f681f';
const CLOCK_OBJECT_ID = '0x6';
const STORAGE_NONE = 0;
const STORAGE_EXTERNAL = 1;
const STORAGE_IPFS = 2;
const STORAGE_ARWEAVE = 3;
const SOURCE_ORIGINAL = 0;
const SOURCE_ONLINE = 1;
const SOURCE_UPLOADED = 2;
const SUI_COIN_ICON_URL = '/archive-assets/sui-coin.png';

// Helper: extract a readable object type + label from a Sui owned-object struct.
// Works with the gRPC client's `listOwnedObjects` shape (objects[].data/objectId/
// version/type/content) as well as the JSON-RPC `getOwnedObjects` shape.
// Derive a coin's display symbol from its Move type, e.g.
//  0x2::coin::Coin<...::suilfg_memefi::SUILFG_MEMEFI> -> "SUILFG_MEMEFI"
//  0x2::coin::Coin<0x2::sui::SUI>                    -> "SUI"
function coinSymbol(type) {
  const m = type.match(/::coin::Coin<(?:[^>]*::)?([^>]+)>$/);
  if (!m) return '';
  const last = m[1].split('::').pop();
  return last || '';
}

function ownerAddressOf(owner) {
  if (!owner) return '';
  if (typeof owner === 'string') return owner;
  return owner.AddressOwner || owner.address || owner.Address?.address || '';
}

function objectStateOf(data) {
  const owner = data?.owner;
  if (owner?.Immutable || owner?.immutable) return { objectStatus: 'Immutable', ownershipStatus: 'Immutable', ownerAddress: '' };
  if (owner?.Shared || owner?.shared) return { objectStatus: 'Shared', ownershipStatus: 'Shared', ownerAddress: '' };
  const ownerAddress = ownerAddressOf(owner);
  if (ownerAddress) return { objectStatus: 'Owned', ownershipStatus: 'Owned', ownerAddress };
  return { objectStatus: 'Unknown', ownershipStatus: 'Unknown', ownerAddress: '' };
}

function describeObject(obj) {
  const data = obj?.data ?? obj;
  const state = objectStateOf(data);
  const rawContent = data?.json || data?.content || data?.contentJson || {};
  const contentJson = rawContent?.json || rawContent?.fields || rawContent;
  const fields = contentJson?.fields || contentJson;
  const type = data?.type || data?.objectType || fields?.type || 'Unknown object';
  const isCoin = type.includes('::coin::Coin<') || type.includes('0x2::coin::Coin');
  // Fallback label for non-coins: last segment of the Move type (e.g.
  // 0x…::voxx::VoxxFile -> "VoxxFile"), so the Object Name row is never blank.
  const typeTail = type.split('::').pop().replace(/>$/, '');
  const name =
    fields.name ||
    (fields.artifact && fields.artifact.fields && fields.artifact.fields.name) ||
    (isCoin ? coinSymbol(type) : typeTail) ||
    '';
  const balanceRaw = fields.balance !== undefined ? fields.balance : contentJson?.balance;
  const display = data?.display?.output || data?.display?.data || data?.display || fields?.display?.output || fields?.display?.data || fields?.display || contentJson?.display?.output || contentJson?.display?.data || contentJson?.display || {};
  const displayFields = display?.data || display;
  const imageUrl =
    fields.image_url ||
    fields.imageUrl ||
    fields.url ||
    displayFields.image_url ||
    displayFields.imageUrl ||
    displayFields.url ||
    displayFields.image ||
    (isCoin && coinSymbol(type) === 'SUI' ? SUI_COIN_ICON_URL : '')
    || '';
  return {
    objectId: data.objectId,
    type,
    version: data.version,
    name: typeof name === 'string' ? name : '',
    isCoin,
    imageUrl,
    exists: true,
    ...state,
    balance:
      balanceRaw !== undefined ? BigInt(balanceRaw) : undefined,
  };
}

// Returns true when the account is explicitly on Sui Mainnet. When chain
// metadata is unavailable (e.g. some injected wallets), allow the call to
// proceed and let the real Mainnet client validate the network.
function isMainnetAccount(account) {
  if (!account) return false;
  const chains = account.chains || [];
  if (chains.length === 0) return true;
  return chains.some((chain) => String(chain).toLowerCase().includes('mainnet'));
}

// Pull the objects the connected account actually owns. We fetch everything via
// `listOwnedObjects`, then for every distinct COIN type we call `listCoins`
// (passing the inner canonical coin type, e.g. `0x97…::suilfg_memefi::SUILFG_MEMEFI`)
// to obtain the real balance. listCoins is the only reliable source of `balance`
// with the gRPC read mask; `listOwnedObjects` does not populate `content`/`balance`
// for coins. This lets partial-amount archiving work for ANY coin type, not just SUI.
export async function fetchObjectById(client, objectId) {
  if (!client || !objectId) throw new Error('Object ID is required');
  const getObject = client.core?.getObject?.bind(client.core) || client.getObject?.bind(client);
  if (!getObject) throw new Error('Sui client cannot read objects');
  const include = client.core ? { json: true, display: true } : { content: true, display: true };
  const result = await getObject({ objectId, include });
  const object = result?.object ?? result?.data ?? result;
  const described = describeObject(object);
  if (!described.objectId || described.type === 'Unknown object') {
    throw new Error('Object metadata is unavailable');
  }
  return described;
}

export async function preflightArchiveTransaction({ client, sender, ...params }) {
  if (!client || !sender) throw new Error('Mainnet client or sender is unavailable');
  const tx = buildArchiveTransaction(params);
  tx.setSender(sender);
  tx.setGasBudget(100_000_000);
  const bytes = await tx.build({ client });
  const simulate = client.core?.simulateTransaction?.bind(client.core) || client.simulateTransaction?.bind(client);
  if (!simulate) return { success: true, unavailable: true, message: 'Simulation API unavailable; transaction build passed.' };
  const result = await simulate({ transaction: bytes, include: { effects: true } });
  const status = result?.effects?.status || result?.Transaction?.status || result?.transaction?.effects?.status;
  const success = status?.success === true || status?.status === 'success' || result?.effects?.status === 'success';
  return { success, unavailable: false, message: status?.error || (success ? 'Preflight passed.' : 'Mainnet simulation did not pass.'), result };
}

export async function fetchOwnedObjects(client, address) {
  if (!client || !address) return [];

  const listOwned = client.core?.listOwnedObjects?.bind(client.core) || client.listOwnedObjects?.bind(client);
  const listCoins = client.core?.listCoins?.bind(client.core) || client.listCoins?.bind(client);
  const getCoinMetadata = client.core?.getCoinMetadata?.bind(client.core) || client.getCoinMetadata?.bind(client);
  const getObject = client.core?.getObject?.bind(client.core) || client.getObject?.bind(client);
  if (!listOwned) throw new Error('Sui client cannot list owned objects');
  const include = client.core ? { json: true, display: true } : { content: true, display: true };
  const collected = [];
  let cursor = null;
  do {
    const result = await listOwned({ owner: address, cursor, limit: 50, include });
    const page = result.objects || result.data || [];
    collected.push(...page);
    cursor = result.hasNextPage ? result.cursor : null;
  } while (cursor);

  const kioskItemContext = new Map();
  // Kiosk items are NOT returned by listOwnedObjects because the Kiosk owns them.
  // The connected account owns a KioskOwnerCap per kiosk; from each cap we read the
  // kiosk id, then enumerate the Kiosk object's dynamic object fields (GraphQL
  // `object(kioskId).dynamicFields`) to surface every item id. KioskOwnerCap is
  // intentionally excluded — it is a capability, not an archivable item.
  if (GRAPHQL_ENDPOINT && getObject) {
    try {
      const caps = collected
        .map((c) => (c?.data ?? c))
        .filter((d) => /::kiosk::KioskOwnerCap(?:<|$)/.test(d?.type || d?.objectType || ''));
      const kioskCapByKiosk = new Map();
      const ownedKiosks = collected
        .map((c) => (c?.data ?? c))
        .filter((d) => /::kiosk::Kiosk(?:<|$)/.test(d?.type || d?.objectType || ''));
      const kioskIds = new Set(ownedKiosks.map((kiosk) => kiosk?.objectId).filter(Boolean));
      for (const cap of caps) {
        const content = cap?.json || cap?.content?.json || cap?.content?.fields || cap?.content || {};
        const fields = content?.fields || content;
        const kioskId=objectIdValue(fields?.kiosk||fields?.kiosk_id||fields?.id);
        if (kioskId) {
          kioskIds.add(kioskId);
          kioskCapByKiosk.set(kioskId, cap?.objectId || '');
        }
      }
      const seen = new Set(collected.map((c) => (c?.data ?? c)?.objectId));
      for (const kioskId of kioskIds) {
        let fieldCursor = null;
        do {
          try {
            const result = await graphqlFetch(KIOSK_FIELDS_QUERY, { id: kioskId, cursor: fieldCursor });
            const conn = result?.object?.dynamicFields;
            const nodes = conn?.nodes || [];
            for (const node of nodes) {
              // Each kiosk item is a dynamic field whose value is the referenced
              // object. Non-object fields (e.g. `Lock`, `Extension`) have no value
              // address and are skipped.
              const itemId=objectIdValue(node?.value?.address||node?.value);
              if (!itemId || seen.has(itemId)) continue;
              kioskItemContext.set(itemId, {
                kioskId,
                kioskOwnerCapId: kioskCapByKiosk.get(kioskId) || '',
              });
              try {
                const obj = await getObject({ objectId: itemId, include });
                // gRPC getObject returns { object: <flat> }, JSON-RPC returns
                // { data: <flat> }; normalize to the flat object shape used by
                // the rest of this function and by describeObject.
                const o = obj?.object ?? obj?.data ?? obj;
                const objType = o?.type || o?.objectType || '';
                if (!/::kiosk::Kiosk(?:OwnerCap|Cap)(?:<|$)/.test(objType)) {
                  collected.push(o);
                  seen.add(itemId);
                }
              } catch (objErr) {
                console.debug('[owned-objects] kiosk item fetch failed', itemId, objErr);
              }
            }
            fieldCursor = conn?.pageInfo?.hasNextPage ? conn?.pageInfo?.endCursor : null;
          } catch (error) {
            console.debug('[owned-objects] kiosk item scan unavailable', kioskId, error);
            fieldCursor = null;
          }
        } while (fieldCursor);
      }
    } catch (error) {
      console.debug('[owned-objects] kiosk scan unavailable', error);
    }
  }

  const described = collected.map(describeObject).filter((o) => o.objectId && o.type !== 'Unknown object' && !/::kiosk::Kiosk(?:OwnerCap|Cap)(?:<|$)/.test(o.type)).map((object) => {
    const kiosk = typeof kioskItemContext === 'undefined' ? null : kioskItemContext.get(object.objectId);
    return kiosk
      ? { ...object, kiosk: true, kioskId: kiosk.kioskId, kioskOwnerCapId: kiosk.kioskOwnerCapId, objectStatus: 'Locked in Kiosk', ownershipStatus: 'Locked in Kiosk' }
      : { ...object, ownershipStatus: object.ownerAddress && object.ownerAddress.toLowerCase() === address.toLowerCase() ? 'Owned by connected wallet' : object.ownershipStatus };
  });
  const coins = described.filter((o) => o.isCoin);
  const nonCoins = described.filter((o) => !o.isCoin && o.objectId);

  // --- Real balances for every distinct coin type via listCoins ---
  // Extract the inner coin type (the part inside `0x2::coin::Coin<...>`) and
  // canonicalise each `0x`-segment (strip leading zeros) so listCoins matches.
  const innerTypeOf = (t) => {
    const m = t.match(/::Coin<(.+)>$/);
    return m ? m[1] : t;
  };
  const norm = (s) =>
    s
      .split('::')
      .map((seg) => (seg.startsWith('0x') ? seg.replace(/0x0+/, '0x') : seg))
      .join('::');

  const balanceByObject = new Map();
  const distinctTypes = [...new Set(coins.map((c) => norm(innerTypeOf(c.type))))];
  if (listCoins) {
    for (const it of distinctTypes) {
      let c = null;
      do {
        const res = await listCoins({ owner: address, coinType: it, cursor: c, limit: 50 });
        for (const obj of res.objects || []) {
          balanceByObject.set(
            obj.objectId,
            obj.balance !== undefined ? BigInt(obj.balance) : undefined,
          );
        }
        c = res.hasNextPage ? res.cursor : null;
      } while (c);
    }
  }

  // Attach the fetched balance to each coin; non-coin objects pass through.
  // SUI is no longer special-cased — it is just another coin type with a balance.
  const coinResults = await Promise.all(coins.map(async (o) => {
    let imageUrl=o.imageUrl;
    if(!imageUrl && getCoinMetadata){
      try{
        const innerType=norm(innerTypeOf(o.type));
        const metaResult=await getCoinMetadata({coinType:innerType});
        const meta=metaResult?.coinMetadata || metaResult?.metadata || metaResult || {};
        imageUrl=meta?.iconUrl || meta?.icon_url || meta?.icon || '';
      }catch(error){
        console.debug('[owned-objects] coin metadata unavailable', o.type, error);
      }
    }
    return {
      ...o,
      imageUrl,
      balance: balanceByObject.has(o.objectId) ? balanceByObject.get(o.objectId) : o.balance,
    };
  }));

  return [...new Map([...coinResults, ...nonCoins].filter((o) => o.objectId).map((o) => [o.objectId, o])).values()];
}

export async function fetchArchivePolicy(client) {
  if (!client) throw new Error('Sui client is unavailable');
  let result;
  let lastError;
  const readers = [
    client.core?.getObject?.bind(client.core),
    client.getObject?.bind(client),
  ].filter(Boolean);
  for (const read of readers) {
    try {
      result = await read({
        objectId: POLICY_OBJECT_ID,
        include: { json: true },
      });
      break;
    } catch (error) {
      lastError = error;
    }
    try {
      result = await read({
        id: POLICY_OBJECT_ID,
        options: { showContent: true },
      });
      break;
    } catch (error) {
      lastError = error;
    }
  }
  if (!result) throw lastError || new Error('Unable to read archive policy');
  const object = result?.object || result?.data || result;
  const json = object?.json || object?.content?.json || object?.content?.fields;
  const content = json || object?.content || result?.content || result?.data?.content;
  const fields = content?.fields || content;
  if (!fields || fields.archive_fee_mist === undefined) {
    throw new Error('Archive policy content is unavailable');
  }
  return {
    archiveFeeMist: BigInt(fields.archive_fee_mist),
    treasury: fields.treasury || '',
    version: Number(fields.version ?? 0),
  };
}

export async function fetchSuiBalance(client, address) {
  const result = await client.getBalance({ owner: address, coinType: '0x2::sui::SUI' });
  const total = result?.balance?.balance ?? result?.totalBalance ?? result?.balance ?? 0;
  return BigInt(total);
}

// Build a `Transaction` that archives the given owned object. The object is
// passed by reference (its ID), and a fresh gas coin is split to cover the
// archive fee. With STORAGE_NONE the hero image URI/hash are left empty, which
// the contract's validate_metadata allows.
//
// For Coin objects the caller may pass `amount` (in MIST). When `amount` is set
// and is less than the coin's full balance, the transaction splits that amount
// off `tx.gas` into a fresh Coin object and archives *that* — so only the chosen
// quantity is frozen, the remainder stays spendable. `typeArgument` must then be
// the concrete coin type, e.g. `0x2::coin::Coin<0x2::sui::SUI>`.
//
// `archive_forever` is generic over `T: key + store`, so the concrete Move type
// of the archived object MUST be supplied as a type argument — omitting it fails
// VM verification with "VerificationOrDeserialization Error in command 1".
export function buildArchiveTransaction({
  objectId,
  typeArgument,
  message,
  sealerSignature,
  sourceType = SOURCE_ORIGINAL,
  storageType = STORAGE_NONE,
  heroUri = '',
  heroHash = [],
  amount,
  kioskId,
  kioskOwnerCapId,
}) {
  const tx = new Transaction();

  const messageArg = tx.pure.string(String(message ?? '').slice(0, 2048));
  const signatureArg = tx.pure.string(
    String(sealerSignature ?? '').slice(0, 256),
  );
  // image_url / image_hash are only meaningful when a real storage
  // backend is used. For STORAGE_NONE both must be empty (contract asserts this).
  const emptyUri = tx.pure.string(String(heroUri ?? ''));
  // The hash must be a 32-byte vector when storage != NONE; empty otherwise.
  const hashVector = Array.isArray(heroHash) && heroHash.length ? heroHash : [];
  const emptyHash = tx.pure.vector('u8', hashVector);
  const storageArg = tx.pure.u8(storageType);

  // archive_forever takes `payment` as &mut Coin<SUI> and does NOT consume it.
  // Passing tx.gas directly (instead of a split coin) avoids creating an unused
  // result with no `drop` ability, which would fail with
  // "UnusedValueWithoutDrop". The policy fee is currently 0, so no SUI moves.
  const payment = tx.gas;

  // The artifact: either the selected object, or — for a partial Coin archive —
  // a freshly split Coin of the requested amount. The split MUST come from the
  // selected coin object (objectId), NOT tx.gas — otherwise we'd freeze part of
  // the user's gas and leave the selected coin untouched. The remainder of the
  // selected coin stays with the user.
  let artifactArg;
  let typeArg = typeArgument;
  if (kioskId && kioskOwnerCapId && typeArgument) {
    // Kiosk items are owned by the Kiosk, not the wallet address. Take the
    // item into the transaction using the wallet's KioskOwnerCap, then pass
    // the returned object into archive_forever. The contract still remains
    // the final authority for the archive call.
    artifactArg = tx.moveCall({
      target: '0x2::kiosk::take',
      typeArguments: [typeArgument],
      arguments: [
        tx.object(kioskId),
        tx.object(kioskOwnerCapId),
        tx.pure.id(objectId),
      ],
    });
  } else if (amount !== undefined && amount !== null && typeArgument && typeArgument.includes('::coin::Coin<')) {
    const [coinType] = typeArgument.split('::Coin<');
    const fullCoinType = `${coinType}::Coin<${typeArgument.split('::Coin<')[1]}`;
    const split = tx.splitCoins(tx.object(objectId), [tx.pure.u64(String(amount))]);
    artifactArg = split[0];
    typeArg = fullCoinType;
  } else {
    artifactArg = tx.object(objectId);
  }

  const args = {
    target: `${PACKAGE_ID}::memory_archive::archive_forever`,
    arguments: [
      tx.object(POLICY_OBJECT_ID), // shared ArchivePolicy
      artifactArg, // the artifact to archive (object or split coin)
      payment, // &mut Coin<SUI> for the fee (gas itself, unused at fee 0)
      messageArg,
      signatureArg,
      emptyUri,
      emptyHash,
      tx.pure.u8(sourceType),
      storageArg,
      tx.object(CLOCK_OBJECT_ID), // Clock
    ],
  };
  if (typeArg) args.typeArguments = [typeArg];

  tx.moveCall(args);

  return tx;
}

export async function estimateArchiveGas({
  client,
  objectId,
  typeArgument,
  sender,
  message = '',
  sealerSignature = '',
  sourceType = SOURCE_ORIGINAL,
  storageType = STORAGE_NONE,
  heroUri = '',
  heroHash = [],
  amount,
}) {
  if (!client?.core?.simulateTransaction || !sender) {
    throw new Error('Gas simulation is unavailable');
  }
  const tx = buildArchiveTransaction({
    objectId,
    typeArgument,
    message,
    sealerSignature,
    sourceType,
    storageType,
    heroUri,
    heroHash,
    amount,
  });
  tx.setSender(sender);
  tx.setGasBudget(50_000_000);
  const bytes = await tx.build({ client });
  const result = await client.core.simulateTransaction({
    transaction: bytes,
    include: { effects: true },
  });
  const gasUsed = result?.effects?.gasUsed;
  if (!gasUsed) throw new Error('Gas simulation returned no gas usage');
  const total = BigInt(gasUsed.computationCost || 0)
    + BigInt(gasUsed.storageCost || 0)
    + BigInt(gasUsed.nonRefundableStorageFee || 0)
    - BigInt(gasUsed.storageRebate || 0);
  if (total <= 0n) throw new Error('Gas simulation returned an invalid estimate');
  return total;
}
// Sign and execute via the connected dAppKit wallet on Mainnet.
export async function archiveObject({
  client,
  dAppKit,
  objectId,
  typeArgument,
  message,
  sealerSignature,
  sourceType = SOURCE_ORIGINAL,
  storageType = STORAGE_NONE,
  heroUri = '',
  heroHash = [],
  amount,
  kioskId,
  kioskOwnerCapId,
}) {
  const tx = buildArchiveTransaction({
    objectId,
    typeArgument,
    message,
    sealerSignature,
    sourceType,
    storageType,
    heroUri,
    heroHash,
    amount,
    kioskId,
    kioskOwnerCapId,
  });
  const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
  return result;
}

// Expose the real on-chain API to the inline wizard script.
window.theArchiveTx = {
  PACKAGE_ID,
  fetchOwnedObjects,
  fetchObjectById,
  preflightArchiveTransaction,
  buildArchiveTransaction,
  archiveObject,
  fetchArchivePolicy,
  estimateArchiveGas,
  fetchSuiBalance,
  isMainnetAccount,
  POLICY_OBJECT_ID,
  STORAGE_NONE,
  STORAGE_EXTERNAL,
  STORAGE_IPFS,
  STORAGE_ARWEAVE,
  SOURCE_ORIGINAL,
  SOURCE_ONLINE,
  SOURCE_UPLOADED,
};
