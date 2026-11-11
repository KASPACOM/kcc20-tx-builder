import { readFile } from 'node:fs/promises';
import { feeRequest, feeRecipes } from '../shared/fee-recipes.ts';
const [recipe, filename] = process.argv.slice(2);
if (!filename) {
  console.log('Usage: npm run fee-request -- <recipe> <config.json>');
  console.log(Object.keys(feeRecipes).join('\n'));
} else {
  try {
    const config = JSON.parse(await readFile(filename, 'utf8'));
    console.log(JSON.stringify(feeRequest(recipe, config), null, 2));
  } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
