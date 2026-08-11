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
    .filter((o) => o.objectId && o.type !== '0x2::coin::Coin<0x2::sui::SUI>')
    .filter((o) => o.type !== '0x2::sui::SUI');
}

// Build a `Transaction` that archives the given owned object. The object is
// passed by reference (its ID), and a fresh gas coin is split to cover the
// archive fee. With STORAGE_NONE the hero image URI/hash are left empty, which
// the contract's validate_metadata allows.
export function buildArchiveTransaction({ objectId, message, sealerSignature }) {
  const tx = new Transaction();

  const messageArg = tx.pure.string(String(message ?? '').slice(0, 2048));
  const signatureArg = tx.pure.string(
    String(sealerSignature ?? '').slice(0, 256),
  );
  const emptyUri = tx.pure.string('');
  // 32-byte zeroed content hash, required to be exactly CONTENT_HASH_BYTES
  // (32) for non-NONE storage; for STORAGE_NONE the contract ignores it, but we
  // still pass a 32-byte vector to satisfy the argument shape.
  const emptyHash = tx.pure.vector('u8', new Array(32).fill(0));
  const storageType = tx.pure.u8(STORAGE_NONE);

  // A gas coin is required for the archive_fee split. We split 0 from gas so
  // the call has a coin object to pass; the policy fee is currently 0, so no
  // real SUI leaves the wallet.
  const [payment] = tx.splitCoins(tx.gas, [0]);

  tx.moveCall({
    target: `${PACKAGE_ID}::memory_archive::archive_forever`,
    arguments: [
      tx.object(POLICY_OBJECT_ID), // shared ArchivePolicy
      tx.object(objectId), // the artifact to archive
      payment, // &mut Coin<SUI> for the fee
      messageArg,
      signatureArg,
      emptyUri,
      emptyHash,
      storageType,
      tx.object(CLOCK_OBJECT_ID), // Clock
    ],
  });

  return tx;
}

// Sign and execute via the connected dAppKit wallet on Testnet.
export async function archiveObject({ client, dAppKit, objectId, message, sealerSignature }) {
  const tx = buildArchiveTransaction({ objectId, message, sealerSignature });
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
};
