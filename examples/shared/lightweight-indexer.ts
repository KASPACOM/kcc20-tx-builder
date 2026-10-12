import type { Kcc20IndexedCovenantUtxo } from "@kaspacom/kcc20-tx-builder/action-source-resolver";
import { network, type Runtime } from "./build.ts";

export type LightweightPage = {
  network: string;
  fresh: boolean;
  items: unknown[];
  nextCursor: string | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function decimal(value: unknown): value is string {
  return typeof value === "string" && /^(0|[1-9][0-9]{0,19})$/.test(value)
    && BigInt(value) <= 0xffffffffffffffffn;
}

// This adapter belongs to the application examples, not the package's public API.
// Decoded rows remain hints until the build path verifies their scripts and current RPC UTXOs.
export function lightweightSources(wasm: Runtime, page: LightweightPage): Kcc20IndexedCovenantUtxo[] {
  if (!record(page) || page.network !== network || page.fresh !== true || !Array.isArray(page.items))
    throw new Error("Wrong-network or stale lightweight-indexer response");
  return page.items.flatMap((row) => {
    if (!record(row)) throw new Error("Invalid indexed source row");
    if (row.verified !== true) return [];
    if (typeof row.outpoint !== "string" || !/^[a-f0-9]{64}:(0|[1-9][0-9]*)$/i.test(row.outpoint)
      || typeof row.covenantId !== "string" || !/^[a-f0-9]{64}$/i.test(row.covenantId))
      throw new Error("Invalid indexed covenant outpoint");
    const [txidHex, index] = row.outpoint.split(":");
    const vout = Number(index);
    if (!Number.isSafeInteger(vout) || vout < 0 || vout > 0xffffffff)
      throw new Error("Invalid output index");
    if (!decimal(row.kasAmount) || !record(row.state) || !record(row.scriptPublicKey))
      throw new Error("Incomplete indexed source");
    const spk = row.scriptPublicKey;
    if (spk.version !== 0 || typeof spk.script !== "string" || !/^(?:[a-f0-9]{2})+$/i.test(spk.script))
      throw new Error("Invalid indexed script public key");
    const script = new wasm.ScriptPublicKey(0, spk.script);
    let address: string;
    try {
      address = wasm.addressFromScriptPublicKey(script, network)?.toString() ?? "";
    } finally {
      script.free();
    }
    if (!address) throw new Error("Unsupported source script");
    const state: Record<string, unknown> = { ...row.state, ownerIdentifier: row.state.owner ?? row.state.ownerIdentifier };
    for (const field of ["amount", "unitPriceSompi", "priceScale", "denomination"]) {
      if (field in state && !decimal(state[field])) throw new Error(`Invalid indexed ${field}`);
    }
    if (row.family === "KCC20" && !decimal(state.amount))
      throw new Error("Missing native token amount");
    // In the pinned universal program, mint authorities have zero token amount.
    // Zero amount alone does not establish that a state is an authority.
    if (row.family === "KCC20" && decimal(state.amount) && BigInt(state.amount) > 0n)
      state.isMintAuthority = false;
    return [{ txidHex: txidHex.toLowerCase(), vout, outpoint: row.outpoint.toLowerCase(), address, amountSompi: row.kasAmount,
      covenantId: row.covenantId.toLowerCase(), state }];
  });
}

export async function readLightweightPages(
  wasm: Runtime, first: LightweightPage, url: URL, fetcher: typeof fetch,
): Promise<Kcc20IndexedCovenantUtxo[]> {
  const rows: Kcc20IndexedCovenantUtxo[] = [];
  const cursors = new Set<string>();
  let page = first;
  for (let count = 0; count < 100; count++) {
    rows.push(...lightweightSources(wasm, page));
    if (rows.length > 1000) throw new Error("Too many sources; narrow covenantId and ownerIdentifier filters");
    if (page.nextCursor === null) return rows;
    if (typeof page.nextCursor !== "string" || cursors.has(page.nextCursor))
      throw new Error("Invalid or repeated pagination cursor");
    cursors.add(page.nextCursor);
    const next = new URL(url); next.searchParams.set("after", page.nextCursor);
    const response = await fetcher(next, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Source page returned HTTP ${response.status}`);
    page = await response.json();
  }
  throw new Error("Source pagination exceeded 100 pages; narrow the query");
}
