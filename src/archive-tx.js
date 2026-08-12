// Real Sui Testnet archival flow.
//
// This module replaces the previous simulated archiving with an actual on-chain
// call to `memory_archive::archive_forever`. Once an object is archived it is
// frozen forever (transfer::freeze_object) and can never be moved, edited, or
// recovered — so every UI path that calls this must warn the user first.

import { Transaction } from '@mysten/sui/transactions';
import { PACKAGE_ID } from './chain-archives.js';

const POLICY_OBJECT_ID =
  '0xa3bc87bb4e816bc2ab1b46bf39333ea7e62f6113329cd21e4a0fee4155a3d9e6';
const CLOCK_OBJECT_ID = '0x6';
const STORAGE_NONE = 0;
const STORAGE_ARWEAVE = 2;

// Helper: extract a readable object type + label from a Sui owned-object struct.
// Works with the gRPC client's `listOwnedObjects` shape (objects[].data/objectId/
// version/type/content) as well as the JSON-RPC `getOwnedObjects` shape.
function describeObject(obj) {
  const data = obj?.data ?? obj;
  const type = data?.type || data?.content?.type || 'Unknown object';
  const fields = data?.content?.fields || {};
  const name =
    fields.name ||
    (fields.artifact && fields.artifact.fields && fields.artifact.fields.name) ||
    '';
  return {
    objectId: data.objectId,
    type,
    version: data.version,
    name: typeof name === 'string' ? name : '',
    isCoin: type.includes('::coin::Coin<') || type.includes('0x2::coin::Coin'),
    imageUrl: data?.display?.data?.image_url || '',
    balance:
      fields.balance !== undefined ? BigInt(fields.balance) : undefined,
  };
}

// Returns true when the account is explicitly on Sui Testnet. When chain
// metadata is unavailable (e.g. some injected wallets), we allow the call to
// proceed and let the real Testnet client round-trip validate the network.
export function isTestnetAccount(account) {
  if (!account) return false;
  const chains = account.chains || [];
  if (chains.length === 0) return true;
  return chains.some((chain) => String(chain).toLowerCase().includes('testnet'));
}

// Pull the objects the connected account actually owns, excluding the gas SUI
// coin and shared/immutable objects (which cannot be archived because they are
// not uniquely owned by this wallet). Uses listOwnedObjects which is available
// on both the gRPC and JSON-RPC clients.
export async function fetchOwnedObjects(client, address) {
  if (!client || !address) return [];
  const include = { showType: true, showContent: true, showDisplay: true };
  const collected = [];
  let cursor = null;
  do {
    // gRPC client exposes listOwnedObjects; fall back to getOwnedObjects for
    // JSON-RPC clients just in case.
    const result = client.listOwnedObjects
      ? await client.listOwnedObjects({ owner: address, cursor, limit: 50, include })
      : await client.getOwnedObjects({ owner: address, cursor, limit: 50, options: include });
    const page = result.objects || result.data || [];
    collected.push(...page);
    cursor = result.hasNextPage ? result.cursor : null;
  } while (cursor);

  return collected
    .map(describeObject)
    // Keep Coin objects too (the wizard lets the user archive a chosen amount),
    // but drop the bare `0x2::sui::SUI` balance type which is not an owned object.
    .filter((o) => o.objectId && o.type !== '0x2::sui::SUI');
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
  storageType = STORAGE_NONE,
  heroUri = '',
  heroHash = [],
  amount,
}) {
  const tx = new Transaction();

  const messageArg = tx.pure.string(String(message ?? '').slice(0, 2048));
  const signatureArg = tx.pure.string(
    String(sealerSignature ?? '').slice(0, 256),
  );
  // hero_image_uri / hero_image_hash are only meaningful when a real storage
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
  // a freshly split Coin of the requested amount.
  let artifactArg;
  let typeArg = typeArgument;
  if (amount !== undefined && amount !== null && typeArgument && typeArgument.includes('::coin::Coin<')) {
    const [coinType] = typeArgument.split('::Coin<');
    const fullCoinType = `${coinType}::Coin<${typeArgument.split('::Coin<')[1]}`;
    const split = tx.splitCoins(tx.gas, [tx.pure.u64(String(amount))]);
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
      storageArg,
      tx.object(CLOCK_OBJECT_ID), // Clock
    ],
  };
  if (typeArg) args.typeArguments = [typeArg];

  tx.moveCall(args);

  return tx;
}

// Sign and execute via the connected dAppKit wallet on Testnet.
export async function archiveObject({
  client,
  dAppKit,
  objectId,
  typeArgument,
  message,
  sealerSignature,
  storageType = STORAGE_NONE,
  heroUri = '',
  heroHash = [],
  amount,
}) {
  const tx = buildArchiveTransaction({
    objectId,
    typeArgument,
    message,
    sealerSignature,
    storageType,
    heroUri,
    heroHash,
    amount,
  });
  const result = await dAppKit.signAndExecuteTransaction({ transaction: tx });
  return result;
}

// Expose the real on-chain API to the inline wizard script.
window.theArchiveTx = {
  fetchOwnedObjects,
  buildArchiveTransaction,
  archiveObject,
  isTestnetAccount,
  POLICY_OBJECT_ID,
  STORAGE_NONE,
  STORAGE_ARWEAVE,
};
