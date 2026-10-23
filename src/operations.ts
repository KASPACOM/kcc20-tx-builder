export const KCC20_BUILDER_KEYS = [
  "kcom-claim.deploy-initializer",
  "kcom-claim.initialize",
  "kcom-claim.fund-vault",
  "kcom-claim.open",
  "kcom-claim.select",
  "kcom-claim.settle",
  "kcom-claim.create-shard",
  "kcom-claim.finish-initialization",
  "kcom-claim.close",
  "kcom-claim.collect",
  "kcom-claim.seal",
  "kcom-claim.finish-settlement",
  "kcom-claim.activate",
  "kcom-claim.recover",
  "kcom-vesting.deploy",
  "kcom-vesting.release",
  "kcom-vesting.finish",
  "kcc20.deploy-token",
  "kcc20.mint",
  "kcc20.set-public-mint-active",
  "kcc20.transfer",
  "kcc20.consolidate-holders",
  "kcc20.reveal-token",
  "kcc20wrapper.deploy-market",
  "kcc20wrapper.wrap",
  "kcc20wrapper.unwrap",
  "kcc20orderbook.create-bid",
  "kcc20orderbook.create-ask",
  "kcc20orderbook.fill-ask",
  "kcc20orderbook.fill-bid",
  "kcc20orderbook.sweep-asks",
  "kcc20orderbook.sweep-bids",
  "kcc20orderbook.consolidate-holders",
  "kcc20orderbook.cancel-ask",
  "kcc20orderbook.cancel-bid",
  "fee-ticket.deploy-root",
  "fee-ticket.update-denomination",
  "fee-ticket.create-from-utility-burn",
  "fee-ticket.burn",
  "fee-ticket.transfer",
  "kcc20-snapshot.deploy-bootstrap",
  "kcc20-snapshot.deploy-controller",
  "kcc20-snapshot.start",
  "kcc20-snapshot.claim",
] as const;

export type Kcc20BuilderKey = (typeof KCC20_BUILDER_KEYS)[number];

export function isKcc20BuilderKey(value: string): value is Kcc20BuilderKey {
  return (KCC20_BUILDER_KEYS as readonly string[]).includes(value);
}

export const BACKEND_ONLY_BUILDER_KEYS = [
  "kcc20orderbook.matcher-settle-crossed",
] as const;

export type BackendOnlyBuilderKey = (typeof BACKEND_ONLY_BUILDER_KEYS)[number];

export function isBackendOnlyBuilderKey(
  value: unknown,
): value is BackendOnlyBuilderKey {
  return (
    typeof value === "string" &&
    (BACKEND_ONLY_BUILDER_KEYS as readonly string[]).includes(value)
  );
}
