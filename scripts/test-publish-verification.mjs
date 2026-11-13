import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
const block = workflow.split('      - name: Verify both registries\n')[1]?.split('\n      - name:')[0];
assert(block, 'Missing registry verification step');
const script = block.split('        run: |\n')[1]?.split('\n').map(line => line.replace(/^          /, '')).join('\n');
assert(script, 'Missing registry verification shell');
assert.match(script, /--cache "\$RUNNER_TEMP\/registry-package-check\/cache"/, 'Use a dedicated download cache rather than a pre-existing package cache');
const root = mkdtempSync(join(tmpdir(), 'kcc20-publish-check-'));
try {
  const bin = join(root, 'bin'); mkdirSync(bin);
  writeFileSync(join(root, 'verify.sh'), script);
  writeFileSync(join(bin, 'npm'), `#!/bin/bash
if [ "$1" = view ]; then echo "$INTEGRITY"; exit 0; fi
n=0; test ! -f "$RUNNER_TEMP/count" || n=$(cat "$RUNNER_TEMP/count")
n=$((n+1)); echo "$n" > "$RUNNER_TEMP/count"
if [ "$CASE" = retry ] && [ "$n" -eq 1 ]; then exit 1; fi
if [ "$CASE" = mismatch ]; then echo '[{"integrity":"different"}]'; else echo '[{"integrity":"fixture-integrity"}]'; fi
`, { mode: 0o755 });
  writeFileSync(join(bin, 'sleep'), '#!/bin/bash\nexit 0\n', { mode: 0o755 });
  assert.equal(spawnSync('bash', ['-n', join(root, 'verify.sh')]).status, 0);
  for (const scenario of ['retry', 'mismatch']) {
    const work = join(root, scenario); mkdirSync(work);
    const result = spawnSync('bash', ['-e', join(root, 'verify.sh')], {
      env: { PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: work,
        INTEGRITY: 'fixture-integrity', VERSION: 'fixture', CASE: scenario },
      encoding: 'utf8', timeout: 15000,
    });
    if (scenario === 'retry') {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(join(work, 'count'), 'utf8').trim(), '2');
      assert.match(result.stdout, /archive is not downloadable yet/);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /integrity mismatch/i);
    }
  }
  console.log('Publisher retries unavailable archives and rejects mismatched downloads');
} finally { rmSync(root, { recursive: true, force: true }); }
