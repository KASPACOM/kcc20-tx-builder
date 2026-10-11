import { prepareSnapshotDeployment, type SnapshotArtifacts, type SnapshotDeploymentDefinition } from './snapshot-deployment.js';
import { bytesToHex } from './encoding.js';
import * as tx from './snapshot-signerless-transactions.js';

export function snapshotStartPayload(definition: SnapshotDeploymentDefinition, prepared: ReturnType<typeof prepareSnapshotDeployment>): string {
  const plan = prepared.plan;
  if (prepared.stage !== 'snapshot-start') throw new Error('snapshot start plan required');
  const opening = {
    ...prepared.extension, ticker: definition.ticker, name: definition.ticker,
    premintSupply: definition.totalSupply, premintRecipient: plan.reserves[0].owner, premintOwnerScheme: 4,
    holderExtensionCommitment: prepared.holderExtensionCommitment, snapshotMigrationId: definition.migrationId,
    snapshotManifestCommitment: definition.manifestCommitment,
    snapshotReserves: plan.reserves.map((reserve: any, shardIndex: number) => ({ ...reserve, shardIndex })),
  };
  return bytesToHex(new TextEncoder().encode(JSON.stringify({ tn10: { v: 1, tmpl: 'KCC20',
    args: Object.entries(opening).map(([name, value]) => ({ name, type: 'value', value })),
  } })));
}

/** Reconstruct the whole transaction from approved definition and pinned artifacts. */
export function verifySnapshotDeploymentTransaction(kw: any, args: {
  definition: SnapshotDeploymentDefinition; artifacts: SnapshotArtifacts; transactionJson: string;
  walletAddress: string; maximumFeeSompi: string; stage: string; signingInputIndexes: number[];
}) {
  const prepared = prepareSnapshotDeployment(kw, args.definition, args.artifacts);
  if (prepared.stage !== args.stage) throw new Error('snapshot stage differs from approved custody');
  const transaction = JSON.parse(args.transactionJson);
  const fundingIndex = prepared.stage === 'snapshot-start' ? args.definition.shards.length + 1 : 0;
  if (JSON.stringify(args.signingInputIndexes) !== JSON.stringify([fundingIndex])) {
    throw new Error('only the snapshot funding input may receive the wallet signature');
  }
  if (transaction.inputs.length !== fundingIndex + 1) throw new Error('unexpected snapshot input count');
  const input = (index: number, script?: Uint8Array) => {
    const value = transaction.inputs[index];
    const previousOutpoint = value.previousOutpoint ?? { transactionId: value.transactionId, index: value.index };
    const serializedSpk = value.utxo.scriptPublicKey;
    const scriptPublicKey = typeof serializedSpk === 'string'
      ? new kw.ScriptPublicKey(parseInt(serializedSpk.slice(0, 4), 16), serializedSpk.slice(4)) : serializedSpk;
    const utxo: any = Object.fromEntries(Object.entries(value.utxo).filter(([, value]) => value !== null));
    return { previousOutpoint, utxo: { ...utxo, amount: BigInt(utxo.amount), blockDaaScore: BigInt(utxo.blockDaaScore), outpoint: previousOutpoint, scriptPublicKey }, script };
  };
  const fundingInput = input(fundingIndex);
  if (fundingInput.utxo.covenantId || fundingInput.utxo.covenant ||
    String(fundingInput.utxo.scriptPublicKey.script) !== String(kw.payToAddressScript(args.walletAddress).script)) {
    throw new Error('snapshot funding must belong to the connected wallet');
  }
  const fee = transaction.inputs.reduce((sum: bigint, value: any) => sum + BigInt(value.utxo.amount), 0n) -
    transaction.outputs.reduce((sum: bigint, value: any) => sum + BigInt(value.value), 0n);
  if (fee < 0n || fee > BigInt(args.maximumFeeSompi)) throw new Error('snapshot fee exceeds reviewed amount');
  const common = { ...args.artifacts, plan: prepared.plan, fundingInput, changeAddress: args.walletAddress, feeSompi: fee };
  let expected;
  if (prepared.stage === 'controller-deploy') expected = tx.buildControllerGenesisUnsignedTransaction(kw, common);
  else if (prepared.stage === 'bootstrap-deploy') expected = tx.buildBootstrapGenesisUnsignedTransaction(kw, common);
  else {
    const plan = prepared.plan;
    const bootstrapInput = input(0, tx.buildSnapshotBootstrapScriptForState(args.artifacts.bootstrapArtifact, plan.bootstrapState));
    const approvedBootstrap = args.definition.bootstrapOutpoint;
    if (!approvedBootstrap || bootstrapInput.previousOutpoint.transactionId !== approvedBootstrap.transactionId || bootstrapInput.previousOutpoint.index !== approvedBootstrap.index) {
      throw new Error('snapshot bootstrap input differs from approved genesis');
    }
    expected = tx.buildSnapshotStartUnsignedTransaction(kw, {
      ...common, payload: snapshotStartPayload(args.definition, prepared),
      bootstrapInput,
      controllerInputs: plan.controllers.map((controller: any, index: number) => {
        const actual = input(index + 1, tx.buildSnapshotControllerScriptForState(args.artifacts.controllerArtifact, controller.stateBefore));
        const approved = args.definition.shards.find(shard => shard.shardIndex === index)?.genesisOutpoint;
        if (!approved || actual.previousOutpoint.transactionId !== approved.transactionId || actual.previousOutpoint.index !== approved.index) {
          throw new Error('snapshot controller input differs from approved genesis');
        }
        return actual;
      }),
    });
  }
  const canonical = (value: any): string => {
    const copy = JSON.parse(JSON.stringify(value));
    delete copy.id; delete copy.mass; delete copy.storageMass;
    delete copy.inputs[fundingIndex].signatureScript;
    // UTXO SDK metadata is host supplied; transaction fields and scripts are compared below.
    for (const entry of copy.inputs) delete entry.utxo;
    const sort = (item: any): any => Array.isArray(item) ? item.map(sort) : item && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, val]) => [key, sort(val)])) : item;
    return JSON.stringify(sort(copy));
  };
  if (canonical(transaction) !== canonical(expected.unsignedTransaction)) throw new Error('snapshot transaction differs from the approved plan');
  return prepared;
}
