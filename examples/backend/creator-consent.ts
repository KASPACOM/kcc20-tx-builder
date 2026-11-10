import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { kcc20CreatorFeeConsent } from '@kaspacom/kcc20-tx-builder';
const { values } = parseArgs({ options: {
  config: { type: 'string' }, signer: { type: 'string' }, sign: { type: 'boolean', default: false },
} });
try {
  if (!values.config) throw new Error('--config is required');
  const config = JSON.parse(await readFile(values.config, 'utf8'));
  const p = config.params;
  if (p.creatorEvidence?.creatorConsentAvailable !== true) throw new Error('Verified creator evidence is required');
  const consent = kcc20CreatorFeeConsent({ tokenId: p.contractCanonicalTokenId,
    marketId: p.marketId, feeTicketId: p.feeTicketId, priceScale: BigInt(p.priceScale), policy: p.feePolicy });
  if (!values.sign) console.log(JSON.stringify({ creatorOwner: p.creatorEvidence.creatorOwner, consent }, null, 2));
  else {
    if (!values.signer) throw new Error('--sign requires a trusted local --signer module');
    const host = await import(pathToFileURL(resolve(values.signer)).href);
    if (typeof host.signMessage !== 'function') throw new Error('Host signer must export signMessage(message)');
    // The package verifies this signature and the authenticated creator again at binding.
    config.params.creatorConsent = { creatorOwner: p.creatorEvidence.creatorOwner,
      signature: await host.signMessage(consent.message) };
    console.log(JSON.stringify(config, null, 2));
  }
} catch (error) { console.error((error as Error).message); process.exitCode = 1; }
