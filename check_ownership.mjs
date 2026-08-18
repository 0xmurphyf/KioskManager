import { Transaction } from '@mysten/sui/transactions';
const PKG = '0x4acc0efedd243eb61ab8f8a3e9c24b09a1838c43d16029e8c8985004dfd67239';
// Real kiosk/cap/item from earlier investigation (VOXX #1617 path)
const kiosk = '0xbc36bb80c7a171b37c484d8d132841b042d7df860f5060c2b18a30ef3a057db7';
const cap = '0x207e73449d61a7d3dd71d5f846841c80b9ffb591b3c7016f39567f5ab0ef91b';
const item = '0x691a9180...'; // placeholder, not needed for ownership check
const nft = '0xdca282f30ff2acc0083c5c90969ae97c59a638a6a50ab9112f7ea17507cdd2b7::voxx__inc_::Nft';
const TP = '0x...'; // placeholder
// Sender that does NOT own the cap (0x5e4... is the local CLI default, unrelated)
const sender = '0x5e4cd70f92b03d27af74d77050f14628dda45db4a9824b62fc285a57d10063c2';
const tx = new Transaction();
try {
  tx.moveCall({
    target: `${PKG}::kiosk_transfers::direct_transfer_to_receiver`,
    typeArguments: [nft],
    arguments: [
      tx.object(kiosk),
      tx.object(cap),
      tx.pure.address('0x81e63b192439fd151ad9304bdaef448cd5b7a382f2f01a6e77b224bb08fb95c8'),
      tx.pure.id('0x0000000000000000000000000000000000000000000000000000000000000001'),
      tx.object('0x0000000000000000000000000000000000000000000000000000000000000002'),
      tx.object('0x0000000000000000000000000000000000000000000000000000000000000002'),
    ],
  });
  tx.setSender(sender);
  console.log('MOVE_CALL_BUILT (only checks arg wiring, not ownership)');
  console.log('OWNERSHIP_ENFORCED_BY: KioskOwnerCap is an owned object (key, no store); to be used as &mut/& input it must be owned by the transaction signer. Any other signer cannot supply it.');
} catch (e) {
  console.log('ERR', e.message);
}
