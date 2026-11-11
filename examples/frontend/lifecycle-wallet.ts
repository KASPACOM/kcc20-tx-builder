import type { Built, Runtime } from '../shared/build.ts';
import { lifecycleBuilder, type Source } from '../shared/lifecycle.ts';

// Use the application's existing connection. This adapter does not create a wallet
// session, node connection or backend cookie, and does not broadcast automatically.
export function browserLifecycle(wasm: Runtime, rpc: Source,
  loadArtifact: (key: string) => Promise<unknown>,
  wallet: { getAccounts(): Promise<string[]>; signTransaction(tx: string, options: unknown): Promise<string> }) {
  const builder = lifecycleBuilder(wasm, rpc, loadArtifact);
  return {
    build: builder.build,
    async sign(built: Built, expectedAddress: string) {
      const accounts = await wallet.getAccounts();
      if (accounts[0] !== expectedAddress || built.metadata.walletAddress !== expectedAddress)
        throw new Error('Wallet account changed; rebuild for the connected wallet');
      return builder.sign(built, { capabilities: { schnorr: true, ecdsa: false },
        sign: (unsigned, inputs) => wallet.signTransaction(unsigned, { signInputs: inputs }) });
    },
    assertFresh: builder.assertFresh,
  };
}
