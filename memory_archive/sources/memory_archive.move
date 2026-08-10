module memory_archive::memory_archive;

use std::string::String;
use sui::clock::Clock;
use sui::coin::Coin;
use sui::event;
use sui::sui::SUI;

const MAX_MESSAGE_BYTES: u64 = 2_048;
const MAX_SIGNATURE_BYTES: u64 = 256;
const MAX_HERO_URI_BYTES: u64 = 2_048;
const CONTENT_HASH_BYTES: u64 = 32;

const STORAGE_NONE: u8 = 0;
const STORAGE_IPFS: u8 = 1;
const STORAGE_ARWEAVE: u8 = 2;

const E_NOT_ADMIN: u64 = 0;
const E_FEE_TOO_LOW: u64 = 1;
const E_MESSAGE_TOO_LONG: u64 = 2;
const E_SIGNATURE_TOO_LONG: u64 = 3;
const E_HERO_URI_TOO_LONG: u64 = 4;
const E_INVALID_STORAGE_TYPE: u64 = 5;
const E_IMAGE_DATA_WITHOUT_STORAGE: u64 = 6;
const E_MISSING_IMAGE_URI: u64 = 7;
const E_INVALID_HASH_LENGTH: u64 = 8;
const E_INVALID_TREASURY: u64 = 9;

/// Shared protocol configuration. Only the holder of `AdminCap` may update it.
public struct ArchivePolicy has key {
    id: UID,
    archive_fee_mist: u64,
    treasury: address,
    version: u64,
    admin_cap_id: ID,
}

/// Capability created once when the package is published.
public struct AdminCap has key, store {
    id: UID,
}

/// An immutable wrapper that permanently contains the archived object.
public struct Memory<T: key + store> has key {
    id: UID,
    artifact: T,
    archived_by: address,
    archived_at_ms: u64,
    message: String,
    sealer_signature: String,
    hero_image_uri: String,
    hero_image_hash: vector<u8>,
    storage_type: u8,
    policy_version: u64,
}

public struct MemoryArchived has copy, drop {
    archive_id: ID,
    original_object_id: ID,
    archived_by: address,
    archived_at_ms: u64,
    storage_type: u8,
    policy_version: u64,
}

public struct PolicyUpdated has copy, drop {
    archive_fee_mist: u64,
    treasury: address,
    version: u64,
}

fun init(ctx: &mut TxContext) {
    let admin = AdminCap { id: object::new(ctx) };
    let admin_cap_id = object::id(&admin);
    let policy = ArchivePolicy {
        id: object::new(ctx),
        archive_fee_mist: 0,
        treasury: ctx.sender(),
        version: 1,
        admin_cap_id,
    };

    transfer::transfer(admin, ctx.sender());
    transfer::share_object(policy);
}

/// Permanently archives `artifact`. The returned wrapper is frozen and can
/// never again be transferred or mutably borrowed through normal Sui rules.
#[allow(lint(freeze_wrapped))]
public fun archive_forever<T: key + store>(
    policy: &ArchivePolicy,
    artifact: T,
    payment: &mut Coin<SUI>,
    message: String,
    sealer_signature: String,
    hero_image_uri: String,
    hero_image_hash: vector<u8>,
    storage_type: u8,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    validate_metadata(
        &message,
        &sealer_signature,
        &hero_image_uri,
        &hero_image_hash,
        storage_type,
    );
    assert!(payment.value() >= policy.archive_fee_mist, E_FEE_TOO_LOW);

    let archived_by = ctx.sender();
    let archived_at_ms = clock.timestamp_ms();
    let original_object_id = object::id(&artifact);
    let memory = Memory<T> {
        id: object::new(ctx),
        artifact,
        archived_by,
        archived_at_ms,
        message,
        sealer_signature,
        hero_image_uri,
        hero_image_hash,
        storage_type,
        policy_version: policy.version,
    };
    let archive_id = object::id(&memory);

    if (policy.archive_fee_mist > 0) {
        let fee_coin = payment.split(policy.archive_fee_mist, ctx);
        transfer::public_transfer(fee_coin, policy.treasury);
    };

    event::emit(MemoryArchived {
        archive_id,
        original_object_id,
        archived_by,
        archived_at_ms,
        storage_type,
        policy_version: policy.version,
    });
    transfer::freeze_object(memory);
}

/// Updates protocol fee settings. Passing a zero fee intentionally makes
/// archiving free while retaining a single canonical entry point.
public fun update_policy(
    policy: &mut ArchivePolicy,
    admin: &AdminCap,
    archive_fee_mist: u64,
    treasury: address,
) {
    assert!(object::id(admin) == policy.admin_cap_id, E_NOT_ADMIN);
    assert!(treasury != @0x0, E_INVALID_TREASURY);

    policy.archive_fee_mist = archive_fee_mist;
    policy.treasury = treasury;
    policy.version = policy.version + 1;

    event::emit(PolicyUpdated {
        archive_fee_mist,
        treasury,
        version: policy.version,
    });
}

fun validate_metadata(
    message: &String,
    sealer_signature: &String,
    hero_image_uri: &String,
    hero_image_hash: &vector<u8>,
    storage_type: u8,
) {
    assert!(message.as_bytes().length() <= MAX_MESSAGE_BYTES, E_MESSAGE_TOO_LONG);
    assert!(
        sealer_signature.as_bytes().length() <= MAX_SIGNATURE_BYTES,
        E_SIGNATURE_TOO_LONG,
    );
    assert!(
        hero_image_uri.as_bytes().length() <= MAX_HERO_URI_BYTES,
        E_HERO_URI_TOO_LONG,
    );
    assert!(storage_type <= STORAGE_ARWEAVE, E_INVALID_STORAGE_TYPE);

    if (storage_type == STORAGE_NONE) {
        assert!(hero_image_uri.as_bytes().is_empty(), E_IMAGE_DATA_WITHOUT_STORAGE);
        assert!(hero_image_hash.is_empty(), E_IMAGE_DATA_WITHOUT_STORAGE);
    } else {
        assert!(!hero_image_uri.as_bytes().is_empty(), E_MISSING_IMAGE_URI);
        assert!(hero_image_hash.length() == CONTENT_HASH_BYTES, E_INVALID_HASH_LENGTH);
    };
}

public fun archive_fee_mist(policy: &ArchivePolicy): u64 { policy.archive_fee_mist }
public fun treasury(policy: &ArchivePolicy): address { policy.treasury }
public fun policy_version(policy: &ArchivePolicy): u64 { policy.version }
public fun storage_none(): u8 { STORAGE_NONE }
public fun storage_ipfs(): u8 { STORAGE_IPFS }
public fun storage_arweave(): u8 { STORAGE_ARWEAVE }

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) { init(ctx) }

#[test_only]
public fun destroy_policy_for_testing(policy: ArchivePolicy) {
    let ArchivePolicy { id, archive_fee_mist: _, treasury: _, version: _, admin_cap_id: _ } = policy;
    id.delete();
}

#[test_only]
public fun destroy_admin_for_testing(admin: AdminCap) {
    let AdminCap { id } = admin;
    id.delete();
}
