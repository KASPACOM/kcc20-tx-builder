export interface Kcc20TransferPayloadFields {
  covenantId: string;
  fromOwnerIdentifier: string;
  recipientOwner: string;
  recipientOwnerScheme: number;
  tokenAmount: bigint;
}

/** Indexer payload for a transfer; source identity is the covenant state owner. */
export function buildAuthenticatedKcc20TransferPayload(
  fields: Kcc20TransferPayloadFields,
): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({
      tn12: {
        v: 1,
        tmpl: "KCC20",
        op: "transfer",
        args: [
          { name: "covenantId", type: "byte[32]", value: fields.covenantId },
          {
            name: "fromOwner",
            type: "byte[32]",
            value: fields.fromOwnerIdentifier,
          },
          {
            name: "recipientOwner",
            type: "byte[32]",
            value: fields.recipientOwner,
          },
          {
            name: "recipientOwnerScheme",
            type: "u64",
            value: String(fields.recipientOwnerScheme),
          },
          {
            name: "tokenAmount",
            type: "u64",
            value: fields.tokenAmount.toString(),
          },
        ],
      },
    }),
  );
}
