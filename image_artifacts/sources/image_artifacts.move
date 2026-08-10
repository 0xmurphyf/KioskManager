module image_artifacts::image_artifacts;

use std::string::String;

/// A freely mintable Testnet image artifact. Its source URL and SHA-256 are
/// retained inside the object before it is permanently archived.
public struct ImageNft has key, store {
    id: UID,
    name: String,
    description: String,
    image_url: String,
    image_hash: vector<u8>,
}

entry fun mint(
    name: String,
    description: String,
    image_url: String,
    image_hash: vector<u8>,
    ctx: &mut TxContext,
) {
    transfer::public_transfer(ImageNft {
        id: object::new(ctx),
        name,
        description,
        image_url,
        image_hash,
    }, ctx.sender());
}
