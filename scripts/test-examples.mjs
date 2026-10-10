import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = new URL("../", import.meta.url);
const temp = mkdtempSync(join(tmpdir(), "kcc20-package-"));
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed`);
}
try {
  run("npm", ["test"]);
  run("npm", ["pack", "--ignore-scripts", "--pack-destination", temp]);
  const { version } = await import("../package.json", {
    with: { type: "json" },
  }).then((m) => m.default);
  const tarball = join(temp, `kaspacom-kcc20-tx-builder-${version}.tgz`);
  run("tar", ["-xzf", tarball, "-C", temp]);
  const consumer = join(temp, "package", "examples");
  run(
    "npm",
    [
      "ci",
      "--registry=https://registry.npmjs.org/",
      "--@kaspacom:registry=https://registry.npmjs.org/",
    ],
    consumer,
  );
  run(
    "npm",
    ["install", "--no-save", "--package-lock=false", tarball],
    consumer,
  );
  run("npm", ["run", "build"], consumer);
  run("npm", ["test"], consumer);
  if (process.argv.includes("--browser"))
    run("npm", ["run", "test:browser"], consumer);
  // Keep checkout commands on the same candidate the extracted consumer tested.
  run("npm", [
    "install",
    "--prefix",
    "examples",
    "--no-save",
    "--package-lock=false",
    tarball,
  ]);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
