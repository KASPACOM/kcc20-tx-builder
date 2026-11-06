/** A request selects a pinned family; source reconstruction still authenticates it. */
export type KcomArtifactProfile = "kcom-production" | "kcom-configurable-v2";

export function kcomArtifactFiles(profile: unknown = "kcom-production") {
  if (profile !== "kcom-production" && profile !== "kcom-configurable-v2") {
    throw new Error("Unsupported KCOM artifact profile");
  }
  const suffix = profile === "kcom-configurable-v2" ? "V2" : "";
  return {
    graph: `KCOMClaimGraph${suffix}.artifact.json`,
    opening: `KCOMClaimOpen${suffix}.artifact.json`,
    vesting: `KCOMVesting${suffix}.artifact.json`,
  };
}
