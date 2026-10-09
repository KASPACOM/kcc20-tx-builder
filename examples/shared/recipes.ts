import { buildKcc20DeployTokenOperation } from '@kaspacom/kcc20-tx-builder/deploy-operation';
import { buildKcc20MintTokenOperation, buildKcc20TransferTokenOperation, buildKcc20NativeConsolidationOperation } from '@kaspacom/kcc20-tx-builder/token-operation';
import { buildKcc20MintAvailabilityOperation } from '@kaspacom/kcc20-tx-builder/mint-availability-operation';
import { buildKcc20VerifyTokenOperation } from '@kaspacom/kcc20-tx-builder/verify-operation';
import { buildKcc20WrapperMarketDeployOperation, buildKcc20WrapTokenOperationFromSnapshot, buildKcc20UnwrapTokenOperationFromSnapshot } from '@kaspacom/kcc20-tx-builder/wrapper-operation';
import { buildKcc20OrderOperation, buildKcc20FillOperation, buildKcc20SweepOperation, buildKcc20CancelOperation, buildKcc20WrappedConsolidationOperation } from '@kaspacom/kcc20-tx-builder/trading-operation';
import { buildFeeTicketRootDeployOperation, buildFeeTicketRootUpdateOperation, buildFeeTicketCreateOperation, buildFeeTicketBurnOperation, buildFeeTicketTransferOperation } from '@kaspacom/kcc20-tx-builder/fee-ticket-operation';
// Each callable keeps the package's existing parameter types for editor help.
// Buy/sell, fill, sweep and cancellation select a builder from their draft.
export const recipes = {
  deploy: buildKcc20DeployTokenOperation,
  transfer: buildKcc20TransferTokenOperation,
  mint: buildKcc20MintTokenOperation,
  mintAvailability: buildKcc20MintAvailabilityOperation,
  consolidate: buildKcc20NativeConsolidationOperation,
  reveal: buildKcc20VerifyTokenOperation,
  deployMarket: buildKcc20WrapperMarketDeployOperation,
  wrap: buildKcc20WrapTokenOperationFromSnapshot,
  unwrap: buildKcc20UnwrapTokenOperationFromSnapshot,
  order: buildKcc20OrderOperation,
  fill: buildKcc20FillOperation,
  sweep: buildKcc20SweepOperation,
  cancel: buildKcc20CancelOperation,
  consolidateWrapped: buildKcc20WrappedConsolidationOperation,
  deployFeeTicketRoot: buildFeeTicketRootDeployOperation,
  updateFeeTicketRoot: buildFeeTicketRootUpdateOperation,
  createFeeTicket: buildFeeTicketCreateOperation,
  burnFeeTicket: buildFeeTicketBurnOperation,
  transferFeeTicket: buildFeeTicketTransferOperation,
};
