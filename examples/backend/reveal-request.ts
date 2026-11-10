import { readFile } from 'node:fs/promises';
import { buildKcc20VerifyTokenOperation } from '@kaspacom/kcc20-tx-builder/verify-operation';
import { engineInput } from '../shared/build.ts';
// Use accepted deployment/UTXO data, never a private backend registration route.
// Mintable tokens can require a paid mint; inspect the generated request and cap
// the complete wallet debit before explicitly signing with the lifecycle runner.
try {
  const filename = process.argv[2];
  if (!filename) throw new Error('Usage: npm run --silent reveal-request -- config.json');
  const { owner, token } = JSON.parse(await readFile(filename, 'utf8'));
  console.log(JSON.stringify(engineInput(buildKcc20VerifyTokenOperation(owner, token, {
    network: 'testnet-10',
  })), null, 2));
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
