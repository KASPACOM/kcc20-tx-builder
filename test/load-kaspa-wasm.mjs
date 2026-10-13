import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadPinnedKaspaWasm(directory) {
  if (!directory) {
    throw new Error(
      "SNAPSHOT_TEST_WASM must point to the pinned Kaspa WASM directory",
    );
  }

  const namespace = await import(pathToFileURL(join(directory, "kaspa.js")));
  const runtime =
    typeof namespace.ScriptPublicKey === "function"
      ? namespace
      : namespace.default;
  if (!runtime || typeof runtime.ScriptPublicKey !== "function") {
    throw new Error("Pinned Kaspa WASM runtime exports are invalid");
  }

  const initSync = namespace.initSync ?? runtime.initSync;
  if (typeof initSync === "function") {
    const module = await readFile(join(directory, "kaspa_bg.wasm"));
    initSync({ module });
  } else if (!runtime.__wasm) {
    throw new Error(
      "Pinned Kaspa WASM runtime is neither initialized nor initializable",
    );
  }

  return runtime;
}
