import { runtime, loadArtifact } from "./runtime.ts";
import { recipeFixtures } from "../shared/recipe-fixtures.ts";
import { inspect } from "../shared/build.ts";
import { readFile } from "node:fs/promises";
import { recipes } from "../shared/recipes.ts";
import { engineInput, type Operation } from "../shared/build.ts";
const name = process.argv[2];
const path = process.argv[3];
if (!Object.hasOwn(recipes, name) || !path)
  throw new Error(
    `Usage: npm run recipe -- <${Object.keys(recipes).join("|")}> arguments.json`,
  );
if (path === "--offline" || path === "--arguments") {
  const fixture = await recipeFixtures(await runtime(), loadArtifact);
  const key = name as keyof typeof recipes;
  const unsigned =
    path === "--offline"
      ? await fixture.build(fixture.operation(key))
      : undefined;
  console.log(
    JSON.stringify(
      unsigned
        ? { inspection: inspect(unsigned), unsigned }
        : fixture.args[key],
      null,
      2,
    ),
  );
} else {
  const args = JSON.parse(await readFile(path, "utf8"));
  if (!Array.isArray(args))
    throw new Error("arguments.json must contain an array of helper arguments");
  const fn = recipes[name as keyof typeof recipes] as (
    ...args: any[]
  ) => unknown;
  const operation = fn(...args) as Operation;
  engineInput(operation); // Reject accidental non-TN10 configuration before RPC access.
  console.log(JSON.stringify(operation, null, 2));
}
