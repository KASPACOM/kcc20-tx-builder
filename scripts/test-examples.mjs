import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = new URL("../", import.meta.url);
const temp = mkdtempSync(join(tmpdir(), "kcc20-package-"));
function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`${command} ${args.join(" ")} failed`);
}
function runNpm(args, cwd = root) {
  const npmCli = process.env.npm_execpath;
  if (npmCli) return run(process.execPath, [npmCli, ...args], cwd);
  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, cwd);
}
try {
  runNpm(["test"]);
  runNpm(["pack", "--ignore-scripts", "--pack-destination", temp]);
  const { version } = await import("../package.json", {
    with: { type: "json" },
  }).then((m) => m.default);
  const tarball = join(temp, `kaspacom-kcc20-tx-builder-${version}.tgz`);
  run("tar", ["-xzf", tarball, "-C", temp]);
  const consumer = join(temp, "package", "examples");
  runNpm(
    [
      "ci",
      "--registry=https://registry.npmjs.org/",
      "--@kaspacom:registry=https://registry.npmjs.org/",
    ],
    consumer,
  );
  runNpm(
    ["install", "--no-save", "--package-lock=false", tarball],
    consumer,
  );
  runNpm(["run", "build"], consumer);
  runNpm(["test"], consumer);
  if (process.argv.includes("--browser"))
    runNpm(["run", "test:browser"], consumer);
  // Keep checkout commands on the same candidate the extracted consumer tested.
  runNpm([
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
