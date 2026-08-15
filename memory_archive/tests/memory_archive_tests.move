#[test_only]
module memory_archive::memory_archive_tests;

use std::string;
use sui::test_scenario;
use memory_archive::memory_archive::{Self, AdminCap, ArchivePolicy};

const ADMIN: address = @0xA;

#[test]
fun initializes_policy_and_admin_cap() {
    let mut scenario = test_scenario::begin(ADMIN);
    memory_archive::init_for_testing(scenario.ctx());

    scenario.next_tx(ADMIN);
    let policy = scenario.take_shared<ArchivePolicy>();
    assert!(policy.archive_fee_mist() == 0, 0);
    assert!(policy.treasury() == ADMIN, 1);
    assert!(policy.policy_version() == 1, 2);
    test_scenario::return_shared(policy);

    let admin = scenario.take_from_sender<AdminCap>();
    scenario.return_to_sender(admin);
    scenario.end();
}

#[test]
fun storage_constants_are_stable() {
    assert!(memory_archive::storage_none() == 0, 0);
    assert!(memory_archive::storage_external() == 1, 1);
    assert!(memory_archive::storage_ipfs() == 2, 2);
    assert!(memory_archive::storage_arweave() == 3, 3);
    assert!(memory_archive::source_original() == 0, 4);
    assert!(memory_archive::source_online() == 1, 5);
    assert!(memory_archive::source_uploaded() == 2, 6);
    let empty = string::utf8(b"");
    assert!(empty.as_bytes().is_empty(), 7);
}

#[test]
fun validates_online_external_pair() {
    memory_archive::validate_metadata_for_testing(
        string::utf8(b"message"), string::utf8(b"signature"),
        string::utf8(b"https://example.com/image.png"),
        vector[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        memory_archive::source_online(), memory_archive::storage_external(),
    );
}

#[test]
fun accepts_original_external_uri_without_hash() {
    memory_archive::validate_metadata_for_testing(
        string::utf8(b"message"), string::utf8(b"signature"),
        string::utf8(b"http://unreachable.example/image.png"), vector[],
        memory_archive::source_original(), memory_archive::storage_external(),
    );
}

#[test]
fun accepts_original_external_uri_with_arbitrary_metadata_hash() {
    memory_archive::validate_metadata_for_testing(
        string::utf8(b"message"), string::utf8(b"signature"),
        string::utf8(b"http://unreachable.example/image.png"), vector[1, 2, 3],
        memory_archive::source_original(), memory_archive::storage_external(),
    );
}

#[test, expected_failure(abort_code = 10)]
fun rejects_online_arweave_pair() {
    memory_archive::validate_metadata_for_testing(
        string::utf8(b"message"), string::utf8(b"signature"),
        string::utf8(b"ar://image"),
        vector[0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
        memory_archive::source_online(), memory_archive::storage_arweave(),
    );
}

#[test, expected_failure(abort_code = 10)]
fun rejects_uploaded_without_storage() {
    memory_archive::validate_metadata_for_testing(
        string::utf8(b"message"), string::utf8(b"signature"), string::utf8(b""), vector[],
        memory_archive::source_uploaded(), memory_archive::storage_none(),
    );
}
