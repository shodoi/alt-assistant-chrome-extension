import { execFileSync, spawnSync } from 'node:child_process';

const rawFiles = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '*.js', '*.mjs'],
    { encoding: 'utf8' }
);
const files = rawFiles.split('\0').filter(Boolean);

for (const file of files) {
    const res = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (res.status !== 0) {
        console.error(`Syntax check failed: ${file}`);
        process.exit(res.status ?? 1);
    }
}
console.log(`Syntax check OK (${files.length} files)`);

const testRes = spawnSync(process.execPath, ['--test', 'test/**/*.test.js'], { stdio: 'inherit' });
process.exit(testRes.status ?? 1);
