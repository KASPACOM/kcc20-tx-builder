const KCC20_WALLET_OPERATION_SCHEMA = "kcc20-wallet-operation-request/v1";

export interface Kcc20WalletOperationOwner {
  walletAddress: string;
  kcc20Owner: string;
}

export interface Kcc20WalletOperationPlan {
  builderKey: string;
  operation: string;
  contract: string;
  action: string;
  description: string;
  params: Record<string, unknown>;
  sourceRequirements?: Record<string, unknown>[];
  signerRequirements?: Record<string, unknown>[];
  warnings?: string[];
  tokenIdentity?: Record<string, unknown>;
}

export interface Kcc20WalletOperationBuildOptions {
  network?: string;
  createdAt?: string;
  requestId?: string;
}

export function buildKcc20WalletOperationFromPlan(
  owner: Kcc20WalletOperationOwner,
  plan: Kcc20WalletOperationPlan,
  options: Kcc20WalletOperationBuildOptions = {},
) {
  const requestId =
    options.requestId ?? `kcc20-${plan.operation}-${randomOperationId()}`;
  return {
    requestId,
    description: plan.description,
    payload: {
      schema: KCC20_WALLET_OPERATION_SCHEMA,
      status: "wallet-operation-ready",
      requestId,
      chain: "kaspa",
      network: options.network ?? "testnet-10",
      createdAt: options.createdAt ?? new Date().toISOString(),
      owner,
      operation: plan.operation,
      contract: plan.contract,
      action: plan.action,
      ...(plan.tokenIdentity ? { tokenIdentity: plan.tokenIdentity } : {}),
      params: plan.params,
      signing: {
        standard: "pskt",
        walletAction: "sign-pskt-transaction",
        status: "missing-funded-pskt",
        builderKey: plan.builderKey,
        builderStatus: "ready-to-build",
        submitTransactionSupported: false,
        missingDependencies: [`backend-funded-pskt-builder:${plan.builderKey}`],
        missingSources: [],
      },
      sourceRequirements: plan.sourceRequirements ?? [],
      signerRequirements: plan.signerRequirements ?? [
        {
          type: "wallet-owner",
          owner: owner.kcc20Owner,
          address: owner.walletAddress,
        },
      ],
      warnings: plan.warnings ?? [],
    },
  };
}

function randomOperationId(): string {
  return globalThis.crypto?.randomUUID?.() ?? fallbackRandomId();
}

function fallbackRandomId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (bytes.some((byte) => byte !== 0)) {
    return [...bytes]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
