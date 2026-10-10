import { buildKcc20ScriptForState } from "@kaspacom/kcc20-tx-builder/abi";
import { buildKcc20TransferTokenOperation } from "@kaspacom/kcc20-tx-builder/token-operation";
import {
  normalizeKcc20IndexedUtxos,
  selectOwnerNativeHolderUtxo,
} from "@kaspacom/kcc20-tx-builder/action-source-resolver";
import { parseKcc20DisplayAmountToBaseUnits } from "@kaspacom/kcc20-tx-builder/token-amount";
import { assertKcc20ArtifactScriptHash } from "@kaspacom/kcc20-tx-builder/artifacts";
import { network, type Runtime, type Sources, type Wallet } from "./build.ts";
import { withTimeout } from "./timeout.ts";

export interface LiveTransferConfig {
  network: "testnet-10";
  stateUrl: string;
  wallet: Wallet;
  covenantId: string;
  decimals: number;
  recipientOwner: string;
  tokenAmount: string;
}
function bytes(value: unknown, field: string): Uint8Array {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/i.test(value))
    throw new Error(`Invalid ${field}`);
  return Uint8Array.from(value.match(/../g)!, (x) => parseInt(x, 16));
}
// Endpoint response: { network: 'testnet-10', utxos: Kcc20IndexedCovenantUtxo[] }.
// It supplies decoded state; RPC independently confirms the current output.
export async function liveTransferOperation(
  wasm: Runtime,
  rpc: Sources,
  loadArtifact: (key: string) => Promise<unknown>,
  config: LiveTransferConfig,
  fetcher: typeof fetch = fetch,
) {
  if (config.network !== network)
    throw new Error("Transfer config requires testnet-10");
  if (
    !Number.isInteger(config.decimals) ||
    config.decimals < 0 ||
    config.decimals > 8
  )
    throw new Error("Invalid decimals");
  bytes(config.covenantId, "native covenant ID");
  bytes(config.recipientOwner, "recipient owner");
  bytes(config.wallet.kcc20Owner, "wallet owner");
  if (
    new wasm.XOnlyPublicKey(config.wallet.kcc20Owner)
      .toAddress(network)
      .toString() !== config.wallet.walletAddress
  )
    throw new Error("Wallet address and owner do not match");
  const url = new URL(config.stateUrl);
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error("State URL must use HTTP or HTTPS");
  const document = await withTimeout(
    (async () => {
      const response = await fetcher(url, {
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok)
        throw new Error(`State endpoint returned HTTP ${response.status}`);
      return await response.json();
    })(),
    "Decoded state query",
  );
  if (
    document.network !== network ||
    !Array.isArray(document.utxos) ||
    document.utxos.length > 1000
  )
    throw new Error("Invalid or wrong-network state response");
  const rows = normalizeKcc20IndexedUtxos(document.utxos);
  if (rows.length !== document.utxos.length)
    throw new Error("State response contains malformed or duplicate outputs");
  const amount = parseKcc20DisplayAmountToBaseUnits(
    config.tokenAmount,
    config.decimals,
    "tokenAmount",
  );
  const holder = selectOwnerNativeHolderUtxo(
    rows.filter((row) => row.covenantId === config.covenantId),
    config.wallet.kcc20Owner,
    amount,
  );
  if (!holder?.state)
    throw new Error("No matching owner holder can cover the transfer");
  const state = holder.state;
  if (
    state.isMintAuthority !== false ||
    state.ownerScheme !== 0 ||
    state.borrowScheme !== 0
  )
    throw new Error("Expected an unborrowed Schnorr holder");
  if (
    typeof state.amount !== "string" ||
    !/^[0-9]+$/.test(state.amount) ||
    BigInt(String(state.amount)) <= 0n
  )
    throw new Error("Invalid holder token amount");
  const artifact = await loadArtifact("KCC20.placeholder.json");
  assertKcc20ArtifactScriptHash("KCC20.placeholder.json", artifact);
  const script = buildKcc20ScriptForState(artifact, {
    amount: BigInt(String(state.amount)),
    owner: bytes(state.ownerIdentifier, "holder owner"),
    ownerScheme: 0,
    borrowScheme: 0,
    borrowGuard: bytes(state.borrowGuard, "borrow guard"),
    extensionCommitment: bytes(
      state.extensionCommitment,
      "extension commitment",
    ),
  });
  const expectedAddress = wasm
    .addressFromScriptPublicKey(wasm.payToScriptHashScript(script), network)!
    .toString();
  if (holder.address !== expectedAddress)
    throw new Error("Decoded state does not match the holder address");
  const response = (await withTimeout(
    rpc.getUtxosByAddresses({ addresses: [holder.address] }),
    "Holder UTXO query",
  )) as {
    entries?: {
      outpoint: { transactionId: string; index: number };
      amount: bigint | string;
      covenantId?: string;
      scriptPublicKey: Parameters<Runtime["addressFromScriptPublicKey"]>[0];
    }[];
  };
  const current = response.entries?.find(
    (row) =>
      String(row.outpoint.transactionId) === holder.txidHex &&
      row.outpoint.index === holder.vout,
  );
  if (!current) throw new Error("Holder is spent or missing from RPC");
  if (String(current.covenantId) !== config.covenantId)
    throw new Error("Holder native covenant ID differs from RPC");
  if (BigInt(current.amount) !== BigInt(holder.amountSompi))
    throw new Error("Holder KAS amount differs from RPC");
  if (
    wasm
      .addressFromScriptPublicKey(current.scriptPublicKey, network)
      ?.toString() !== expectedAddress
  )
    throw new Error("Holder script differs from RPC");
  return buildKcc20TransferTokenOperation(
    config.wallet,
    {
      token: { covenantId: config.covenantId, decimals: config.decimals },
      activeUtxos: [holder],
      recipientOwner: config.recipientOwner,
      tokenAmount: config.tokenAmount,
    },
    { network },
  );
}
