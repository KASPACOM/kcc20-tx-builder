export interface Kcc20DeployReceiptOutput {
  index: number;
  revealScriptHex: string;
  extensionCommitment: string;
}

export interface Kcc20DeployMinterReceiptOutput extends Kcc20DeployReceiptOutput {
  remainingSupply: string | bigint;
}

export interface Kcc20DeployIntentOutput {
  role: "fixed-supply-token" | "mint-authority" | "premint-holder";
  index: number;
  shard?: number;
  mintLaneIndex?: number;
  covenantId: string;
  revealScriptHex: string;
  owner: string;
  ownerScheme: number;
  borrowScheme: number;
  borrowGuard: string;
  extensionCommitment: string;
  tokenAmount: string;
  remainingSupply?: string;
}

export interface BuildKcc20DeployIntentOutputsInput {
  mintPolicy: number;
  covenantId: string;
  creator: string;
  premintRecipient: string;
  premintOwnerScheme: number;
  maxSupply: string | bigint;
  premintSupply: string | bigint;
  borrowGuard: string;
  fixedOutput?: Kcc20DeployReceiptOutput | null;
  minterOutputs?: readonly Kcc20DeployMinterReceiptOutput[];
  premintOutput?: Kcc20DeployReceiptOutput | null;
}

/**
 * Describes the covenant outputs created by a KCC20 deploy transaction.
 *
 * Fixed-supply deployments create one holder output. Mintable deployments
 * create one or more mint-authority lanes and may append a premint holder.
 * Keeping this mapping next to the transaction builder prevents receipts from
 * claiming that output zero owns supply it does not actually contain.
 */
export function buildKcc20DeployIntentOutputs(
  input: BuildKcc20DeployIntentOutputsInput,
): Kcc20DeployIntentOutput[] {
  const mintPolicy = requireMintPolicy(input.mintPolicy);
  const maxSupply = unsignedInteger(input.maxSupply, "maxSupply");
  const premintSupply = unsignedInteger(input.premintSupply, "premintSupply");
  const minterOutputs = [...(input.minterOutputs ?? [])];

  if (maxSupply === 0n) {
    throw new Error("KCC20 deploy receipt maxSupply must be positive");
  }
  if (premintSupply > maxSupply) {
    throw new Error(
      "KCC20 deploy receipt premintSupply cannot exceed maxSupply",
    );
  }

  if (mintPolicy === 0) {
    if (!input.fixedOutput) {
      throw new Error("fixed KCC20 deploy receipt output is required");
    }
    if (minterOutputs.length || input.premintOutput) {
      throw new Error(
        "fixed KCC20 deploy receipt cannot contain mint-authority or premint outputs",
      );
    }
    if (premintSupply !== maxSupply) {
      throw new Error(
        "fixed KCC20 deploy receipt must assign the full supply to its holder",
      );
    }
    assertUniqueOutputIndexes([input.fixedOutput]);
    return [
      holderIntent("fixed-supply-token", input.fixedOutput, input, maxSupply),
    ];
  }

  if (!minterOutputs.length) {
    throw new Error(
      "mintable KCC20 deploy receipt requires at least one mint-authority lane",
    );
  }
  if (input.fixedOutput) {
    throw new Error(
      "mintable KCC20 deploy receipt cannot contain a fixed-supply output",
    );
  }
  const hasPremint = premintSupply > 0n;
  if (hasPremint !== Boolean(input.premintOutput)) {
    throw new Error(
      "mintable KCC20 deploy receipt premint output does not match premintSupply",
    );
  }

  const laneSupplies = minterOutputs.map((output, laneIndex) => {
    const supply = unsignedInteger(
      output.remainingSupply,
      `mint lane ${laneIndex} remainingSupply`,
    );
    if (supply === 0n) {
      throw new Error(
        `mint lane ${laneIndex} remainingSupply must be positive`,
      );
    }
    return supply;
  });
  const laneSupply = laneSupplies.reduce((sum, supply) => sum + supply, 0n);
  if (laneSupply + premintSupply !== maxSupply) {
    throw new Error(
      "mintable KCC20 deploy receipt lane and premint supply must equal maxSupply",
    );
  }
  assertUniqueOutputIndexes([
    ...minterOutputs,
    ...(input.premintOutput ? [input.premintOutput] : []),
  ]);

  const intents: Kcc20DeployIntentOutput[] = minterOutputs.map(
    (output, laneIndex) => ({
      role: "mint-authority",
      shard: laneIndex,
      mintLaneIndex: laneIndex,
      index: output.index,
      covenantId: input.covenantId,
      revealScriptHex: output.revealScriptHex,
      owner: input.creator,
      ownerScheme: 0,
      borrowScheme: 0,
      borrowGuard: input.borrowGuard,
      extensionCommitment: output.extensionCommitment,
      tokenAmount: "0",
      remainingSupply: laneSupplies[laneIndex].toString(),
    }),
  );

  if (input.premintOutput) {
    intents.push(
      holderIntent("premint-holder", input.premintOutput, input, premintSupply),
    );
  }
  return intents;
}

function holderIntent(
  role: "fixed-supply-token" | "premint-holder",
  output: Kcc20DeployReceiptOutput,
  input: BuildKcc20DeployIntentOutputsInput,
  tokenAmount: bigint,
): Kcc20DeployIntentOutput {
  return {
    role,
    index: output.index,
    covenantId: input.covenantId,
    revealScriptHex: output.revealScriptHex,
    owner: input.premintRecipient,
    ownerScheme: input.premintOwnerScheme,
    borrowScheme: 0,
    borrowGuard: input.borrowGuard,
    extensionCommitment: output.extensionCommitment,
    tokenAmount: tokenAmount.toString(),
  };
}

function requireMintPolicy(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 2) {
    throw new Error("KCC20 deploy receipt mintPolicy must be 0, 1, or 2");
  }
  return value;
}

function assertUniqueOutputIndexes(
  outputs: readonly Kcc20DeployReceiptOutput[],
): void {
  const indexes = new Set<number>();
  for (const output of outputs) {
    if (!Number.isInteger(output.index) || output.index < 0) {
      throw new Error("KCC20 deploy receipt output index must be nonnegative");
    }
    if (indexes.has(output.index)) {
      throw new Error("KCC20 deploy receipt output indexes must be unique");
    }
    indexes.add(output.index);
  }
}

function unsignedInteger(value: string | bigint, label: string): bigint {
  const raw = String(value);
  if (!/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error(`${label} must be an unsigned integer`);
  }
  return BigInt(raw);
}
