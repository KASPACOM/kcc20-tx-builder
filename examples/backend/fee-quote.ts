// Local arithmetic only: no wallet connection, credentials, or broadcast.
import { calculateKcc20EscrowFees } from '@kaspacom/kcc20-tx-builder/escrow-fee';
const fees = calculateKcc20EscrowFees({
  grossSompi: 10_000_000_000n, // 100 KAS
  creatorFeeBps: 100, // 1%
  protocolWaived: false,
});
console.log(JSON.stringify(fees, (_key, value) =>
  typeof value === 'bigint' ? value.toString() : value, 2));
