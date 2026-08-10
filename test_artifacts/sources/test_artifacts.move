module test_artifacts::test_artifacts;

use std::string::String;

/// A deliberately minimal, freely mintable Testnet artifact for archive verification.
public struct TestNft has key, store {
    id: UID,
    name: String,
    description: String,
}

public fun mint(name: String, description: String, ctx: &mut TxContext) {
    transfer::public_transfer(TestNft {
        id: object::new(ctx),
        name,
        description,
    }, ctx.sender());
}
