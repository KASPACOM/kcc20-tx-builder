import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const evidence =
  process.env.CONSOLIDATION_EVIDENCE ??
  (await mkdtemp(join(tmpdir(), "kcc20-consolidation-")));
for (const [program, args] of [
  [process.execPath, ["--test", "test/consolidation-transaction.mjs"]],
  [
    "cargo",
    [
      "run",
      "--locked",
      "--manifest-path",
      "test/consolidation-consensus/Cargo.toml",
      "--",
      join(evidence, "transactions.json"),
    ],
  ],
]) {
  const result = spawnSync(program, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, CONSOLIDATION_EVIDENCE: evidence },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(`Consensus evidence: ${evidence}`);
