import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const root = new URL('../', import.meta.url);
const temp = mkdtempSync(join(tmpdir(), 'kcc20-package-'));
function run(args, cwd = root) {
  const result = spawnSync('npm', args, { cwd, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`npm ${args.join(' ')} failed`);
}
try {
  run(['pack', '--pack-destination', temp]);
  run(['ci', '--prefix', 'examples', '--registry=https://registry.npmjs.org/', '--@kaspacom:registry=https://registry.npmjs.org/']);
  const { version } = await import('../package.json', { with: { type: 'json' } }).then(m => m.default);
  run(['install', '--prefix', 'examples', '--no-save', '--package-lock=false', join(temp, `kaspacom-kcc20-tx-builder-${version}.tgz`)]);
  run(['run', 'build', '--prefix', 'examples']);
  run(['test', '--prefix', 'examples']);
  if (process.argv.includes('--browser')) run(['run', 'test:browser', '--prefix', 'examples']);
} finally { rmSync(temp, { recursive: true, force: true }); }
