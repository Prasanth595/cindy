// Build-time only. Installed Cindy never needs Rust or downloads executable code.
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, chmodSync, writeFileSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = {
  'darwin-arm64': 'aarch64-apple-darwin', 'darwin-x64': 'x86_64-apple-darwin',
  'linux-arm64': 'aarch64-unknown-linux-gnu', 'linux-x64': 'x86_64-unknown-linux-gnu',
  'win32-x64': 'x86_64-pc-windows-msvc',
};
const crate = path.join(desktop, 'native', 'command-rules');
const sourceHash = createHash('sha256');
for (const file of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml', 'src/main.rs', 'src/discover.rs', 'src/source_fs.rs']) {
  sourceHash.update(file).update('\0').update(readFileSync(path.join(crate, file))).update('\0');
}
const helperSourceSha256 = sourceHash.digest('hex');
const assets = path.join(desktop, 'resources', 'tools', 'command-rules');
if (process.argv[2] === '--stage') {
  const source = process.env.CINDY_COMMAND_RULES_ASSETS_DIR || assets;
  const required = [...Object.keys(targets).filter((key) => !key.startsWith('win32')), ...(process.argv[3]?.startsWith('win32') ? ['win32-x64'] : [])];
  for (const key of required) {
    const name = key.startsWith('win32') ? 'cindy-command-rules.exe' : 'cindy-command-rules';
    const folder = path.join(source, key);
    const manifest = JSON.parse(readFileSync(path.join(folder, 'manifest.json'), 'utf8'));
    const binary = readFileSync(path.join(folder, name));
    if (manifest.schemaVersion !== 1 || manifest.helperSourceSha256 !== helperSourceSha256 || manifest.engineVersion !== '0.145.0'
      || manifest.upstreamCommit !== '25af12f7e61572b0bc18ddb1008be543b91519b0' || manifest.platform !== key
      || manifest.sha256 !== createHash('sha256').update(binary).digest('hex')) throw new Error(`Invalid command rules asset: ${key}`);
    const destination = path.join(assets, key);
    mkdirSync(destination, { recursive: true });
    for (const file of [name, 'manifest.json', 'THIRD-PARTY-NOTICES.txt']) {
      if (path.resolve(folder, file) !== path.resolve(destination, file)) copyFileSync(path.join(folder, file), path.join(destination, file));
      else readFileSync(path.join(folder, file));
    }
    chmodSync(path.join(destination, name), 0o755);
  }
  process.exit(0);
}
const key = process.argv[2] || `${process.platform}-${process.arch}`;
const target = targets[key];
if (!target) throw new Error(`Unsupported command rules target: ${key}`);
const built = spawnSync('cargo', ['build', '--locked', '--release', '--target', target, '--manifest-path', path.join(crate, 'Cargo.toml')],
  { cwd: crate, stdio: 'inherit' });
if (built.status !== 0) throw new Error(`Native command rules build failed: ${key}`);
const name = key.startsWith('win32') ? 'cindy-command-rules.exe' : 'cindy-command-rules';
const binary = path.join(path.resolve(crate, process.env.CARGO_TARGET_DIR || 'target'), target, 'release', name);
const output = path.join(desktop, 'resources', 'tools', 'command-rules', key);
mkdirSync(output, { recursive: true });
copyFileSync(binary, path.join(output, name));
chmodSync(path.join(output, name), 0o755);
const notices = spawnSync(process.execPath, [path.join(desktop, '..', '..', 'scripts', 'generate-third-party-notices.mjs'),
  '--command-rules-notice', target, path.join(output, 'THIRD-PARTY-NOTICES.txt')], { stdio: 'inherit' });
if (notices.status !== 0) throw new Error(`Native command rules license audit failed: ${key}`);
writeFileSync(path.join(output, 'manifest.json'), JSON.stringify({
  schemaVersion: 1, engineVersion: '0.145.0', upstreamCommit: '25af12f7e61572b0bc18ddb1008be543b91519b0',
  platform: key, helperSourceSha256, sha256: createHash('sha256').update(readFileSync(binary)).digest('hex'),
}));
