#!/usr/bin/env node
// Run after compiling contracts and generating their registry. Never reads uploads.
import { readFile, writeFile, copyFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
const contracts = process.argv[2];
if (!contracts)
  throw Error(
    "Usage: node scripts/sync-reviewed-artifacts.mjs /path/to/kaspa-covenants",
  );
const root = new URL("../", import.meta.url),
  sha = (x) => createHash("sha256").update(x).digest("hex");
const artifactSources = [
  ["kcc20", "KCC20"],
  ["kcc20-snapshot-bootstrap", "KCC20SnapshotBootstrap"],
  ["kcc20-snapshot-controller", "KCC20SnapshotController"],
  ["kcc20-orderbook", "KCC20Orderbook"],
  ["kcc20-wrapper", "KCC20Wrapper"],
  ["kcc20-fee-ticket", "KCC20FeeTicket"],
  ["kcc20-vesting", "KCC20Vesting"],
];
const sourceMap = Object.fromEntries(
  artifactSources.map(([stem, name]) => [name, stem]),
);
const contractsCommit = execFileSync(
  "git",
  [
    "-c",
    `safe.directory=${resolve(contracts)}`,
    "-C",
    resolve(contracts),
    "rev-parse",
    "HEAD",
  ],
  { encoding: "utf8" },
).trim();
if (!/^[0-9a-f]{40}$/.test(contractsCommit)) {
  throw Error("contracts repository HEAD is not a full Git commit");
}
for (const [stem, name] of artifactSources) {
  for (const relativePath of [
    `contracts/${stem}.sil`,
    `wallet-lab/vendor/${stem}/${name}.generated.args.json`,
    `wallet-lab/vendor/${stem}/${name}.placeholder.json`,
  ]) {
    try {
      execFileSync(
        "git",
        [
          "-c",
          `safe.directory=${resolve(contracts)}`,
          "-C",
          resolve(contracts),
          "diff",
          "--quiet",
          contractsCommit,
          "--",
          relativePath,
        ],
        { stdio: "ignore" },
      );
    } catch {
      throw Error(
        `contracts input ${relativePath} differs from pinned commit ${contractsCommit}`,
      );
    }
  }
}
const registryRaw = await readFile(
  resolve(contracts, "wallet-lab/vendor/token-profiles/registry.json"),
  "utf8",
);
const digest = (
  await readFile(
    resolve(contracts, "wallet-lab/vendor/token-profiles/registry.sha256"),
    "utf8",
  )
).trim();
const registry = JSON.parse(registryRaw);
const canonical = (x) =>
  x === null || typeof x !== "object"
    ? JSON.stringify(x)
    : Array.isArray(x)
      ? `[${x.map(canonical).join(",")}]`
      : `{${Object.keys(x)
          .sort()
          .map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`)
          .join(",")}}`;
if (sha(canonical(registry)) !== digest)
  throw Error("contracts registry digest mismatch");
let pins = await readFile(new URL("src/artifacts.ts", root), "utf8");
for (const [dir, name] of artifactSources) {
  const filename = name + ".placeholder.json",
    destination = new URL("artifacts/" + filename, root);
  const old = await readFile(destination),
    raw = await readFile(
      resolve(contracts, `wallet-lab/vendor/${dir}/${filename}`),
    );
  const before = JSON.parse(old),
    after = JSON.parse(raw);
  pins = pins
    .replaceAll(
      sha(Uint8Array.from(before.script)),
      sha(Uint8Array.from(after.script)),
    )
    .replaceAll(sha(old), sha(raw));
  if (name.startsWith("KCC20Snapshot")) {
    pins = pins.replace(
      `scriptLength: ${before.script.length}`,
      `scriptLength: ${after.script.length}`,
    );
    pins = pins.replace(
      `stateLength: ${before.state_layout.len}`,
      `stateLength: ${after.state_layout.len}`,
    );
  }
  await writeFile(destination, raw);
}
const native = registry.profiles.find((p) => p.nativeExtensions);
if (!native) throw Error("native profile is missing");
pins = pins.replace(
  /(KCC20_SNAPSHOT_TOKEN_TEMPLATE_PIN = Object.freeze\(\{\s*hash: ")[0-9a-f]+/,
  `$1${native.templateHash}`,
);
pins = pins.replace(
  /(KCC20_SNAPSHOT_TOKEN_TEMPLATE_PIN = Object.freeze\(\{[\s\S]*?prefixLength: )\d+/,
  `$1${native.stateLayout.start}`,
);
pins = pins.replace(
  /(KCC20_SNAPSHOT_TOKEN_TEMPLATE_PIN = Object.freeze\(\{[\s\S]*?suffixLength: )\d+/,
  `$1${native.scriptLength - native.stateLayout.start - native.stateLayout.len}`,
);
await writeFile(new URL("src/artifacts.ts", root), pins);
for (const p of registry.profiles.filter((p) => !p.nativeExtensions)) {
  if (!/^[A-Za-z0-9.-]+\.json$/.test(p.artifactKey))
    throw Error("unsafe artifact key");
  const raw = await readFile(
    resolve(contracts, "wallet-lab/vendor/token-profiles", p.artifactKey),
  );
  if (sha(raw) !== p.artifactSha256)
    throw Error("external artifact hash mismatch");
  await writeFile(new URL("artifacts/" + p.artifactKey, root), raw);
}
for (const p of registry.profiles.filter(
  (p) => p.wrapper && !p.nativeExtensions,
)) {
  const w = p.wrapper;
  if (!/^[A-Za-z0-9.-]+\.json$/.test(w.artifactKey))
    throw Error("unsafe wrapper artifact key");
  const raw = await readFile(
    resolve(contracts, "wallet-lab/vendor/token-profiles", w.artifactKey),
  );
  if (sha(raw) !== w.artifactSha256)
    throw Error("wrapper artifact hash mismatch");
  await writeFile(new URL("artifacts/" + w.artifactKey, root), raw);
}
await writeFile(new URL("artifacts/token-profiles.json", root), registryRaw);
await writeFile(
  new URL("artifacts/token-profiles.sha256", root),
  digest + "\n",
);
await writeFile(
  new URL("src/token-profiles.generated.ts", root),
  '// Generated by scripts/sync-reviewed-artifacts.mjs. Do not edit.\nimport type { TokenProfileRegistry } from "./token-profiles.js";\nexport const BUNDLED_TOKEN_PROFILE_DIGEST = ' +
    JSON.stringify(digest) +
    ";\nexport const BUNDLED_TOKEN_PROFILES: TokenProfileRegistry = " +
    registryRaw.trim() +
    ";\n",
);
await copyFile(
  resolve(contracts, "wallet-lab/standards.lock.json"),
  new URL("artifacts/snapshot-standards.lock.json", root),
);
console.log("Synchronized artifacts and registry " + digest);

const compatibilityPath = new URL("docs/COMPATIBILITY.json", root);
const compatibility = JSON.parse(await readFile(compatibilityPath, "utf8"));
const packageMetadata = JSON.parse(
  await readFile(new URL("package.json", root), "utf8"),
);
let compilerGeneration;
for (const [name, pin] of Object.entries(compatibility.artifacts)) {
  const raw = await readFile(new URL("artifacts/" + name, root));
  const a = JSON.parse(raw);
  pin.fileSha256 = sha(raw);
  pin.scriptSha256 = sha(Uint8Array.from(a.script));
  const stem = sourceMap[name.replace(".placeholder.json", "")];
  if (!stem) {
    throw Error(`compatibility artifact ${name} is outside sourceMap`);
  }
  pin.sourceSha256 = sha(
    await readFile(resolve(contracts, "contracts/" + stem + ".sil")),
  );
  pin.constructorArgsSha256 = sha(
    await readFile(
      resolve(
        contracts,
        `wallet-lab/vendor/${stem}/${name.replace(".placeholder.json", ".generated.args.json")}`,
      ),
    ),
  );
  pin.abiSha256 = sha(JSON.stringify(a.abi));
  pin.compilerBuild = a.generation?.compiler_build;

  const generation = {
    tag: a.generation?.silverscript_tag,
    commit: a.generation?.silverscript_commit,
    tree: a.generation?.silverscript_tree,
  };
  if (
    Object.values(generation).some((value) => !value) ||
    !pin.compilerBuild
  ) {
    throw Error(`artifact ${name} is missing compiler provenance`);
  }
  if (
    compilerGeneration &&
    JSON.stringify(generation) !== JSON.stringify(compilerGeneration)
  ) {
    throw Error(`artifact ${name} has inconsistent compiler provenance`);
  }
  compilerGeneration ??= generation;
}
compatibility.packageVersion = packageMetadata.version;
compatibility.contractsCommit = contractsCommit;
compatibility.contractsSourceStatus =
  "reviewed source and generated inputs pinned to contractsCommit";
Object.assign(compatibility.compiler, compilerGeneration);
delete compatibility.compiler.build;
delete compatibility.compiler.releaseAsset;
delete compatibility.compiler.releaseAssetSha256;
delete compatibility.compiler.releaseAssets;
await writeFile(
  compatibilityPath,
  JSON.stringify(compatibility, null, 2) + "\n",
);
