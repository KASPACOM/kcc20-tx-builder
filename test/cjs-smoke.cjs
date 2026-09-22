const root = require("@kaspacom/kcc20-tx-builder");
const deploy = require("@kaspacom/kcc20-tx-builder/deploy-operation");
const wrapper = require("@kaspacom/kcc20-tx-builder/wrapper-operation");

for (const [name, value] of Object.entries({
  createKcc20PsktBuilderEngine: root.createKcc20PsktBuilderEngine,
  buildKcc20DeployTokenOperation: deploy.buildKcc20DeployTokenOperation,
  buildKcc20WrapTokenOperation: wrapper.buildKcc20WrapTokenOperation,
})) {
  if (typeof value !== "function") {
    throw new Error(`CommonJS package export is missing ${name}`);
  }
}

console.log("CommonJS package exports smoke test passed");
