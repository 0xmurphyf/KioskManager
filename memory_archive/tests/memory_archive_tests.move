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
    assert!(memory_archive::storage_ipfs() == 1, 1);
    assert!(memory_archive::storage_arweave() == 2, 2);
    let empty = string::utf8(b"");
    assert!(empty.as_bytes().is_empty(), 3);
}
