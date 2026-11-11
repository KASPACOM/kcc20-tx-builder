import { readFile } from 'node:fs/promises';
import { buildKcc20DeployTokenOperation } from '@kaspacom/kcc20-tx-builder/deploy-operation';
import { engineInput } from '../shared/build.ts';
const filename = process.argv[2];
try {
  if (!filename) throw new Error('Usage: npm run --silent deploy-request -- config.json');
  const { owner, token } = JSON.parse(await readFile(filename, 'utf8'));
  const operation = buildKcc20DeployTokenOperation(owner, token, { network: 'testnet-10' });
  console.log(JSON.stringify(engineInput(operation), null, 2));
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
