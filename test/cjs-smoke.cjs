const root = require("@kaspacom/kcc20-tx-builder");
const deploy = require("@kaspacom/kcc20-tx-builder/deploy-operation");
const wrapper = require("@kaspacom/kcc20-tx-builder/wrapper-operation");

for (const [legacy, canonical] of [
  [
    "@kaspacom/kcc20-tx-builder/artifacts/kcc20-snapshot-bootstrap/KCC20SnapshotBootstrap.placeholder.json",
    "@kaspacom/kcc20-tx-builder/artifacts/KCC20SnapshotBootstrap.placeholder.json",
  ],
  [
    "@kaspacom/kcc20-tx-builder/artifacts/kcc20-snapshot-controller/KCC20SnapshotController.placeholder.json",
    "@kaspacom/kcc20-tx-builder/artifacts/KCC20SnapshotController.placeholder.json",
  ],
]) {
  if (require.resolve(legacy) !== require.resolve(canonical)) {
    throw new Error(`legacy artifact path does not resolve to ${canonical}`);
  }
}

for (const [name, value] of Object.entries({
  createKcc20PsktBuilderEngine: root.createKcc20PsktBuilderEngine,
  buildKcc20DeployTokenOperation: deploy.buildKcc20DeployTokenOperation,
  buildKcc20WrapTokenOperation: wrapper.buildKcc20WrapTokenOperation,
  createKcc20SnapshotPsktBuilder: root.createKcc20SnapshotPsktBuilder,
  buildSnapshotBootstrapScriptForState:
    root.buildSnapshotBootstrapScriptForState,
})) {
  if (typeof value !== "function") {
    throw new Error(`CommonJS package export is missing ${name}`);
  }
}

console.log("CommonJS package exports smoke test passed");
