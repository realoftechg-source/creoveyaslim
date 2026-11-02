const fs = require('fs');
const path = require('path');

const rootDir = path.resolve(__dirname, '..');
const distDir = path.join(rootDir, 'dist');
const downloadsDir = path.join(rootDir, '..', 'public', 'downloads');

function findInstaller() {
  if (!fs.existsSync(distDir)) {
    throw new Error(`Dist directory not found: ${distDir}`);
  }

  const candidates = fs.readdirSync(distDir)
    .filter((name) => /^Creoveya.*\.exe$/i.test(name) || /^Creoveya.*\.exe$/i.test(name))
    .sort((a, b) => fs.statSync(path.join(distDir, b)).mtimeMs - fs.statSync(path.join(distDir, a)).mtimeMs);

  const preferred = candidates.find((name) => /CreoveyaSetup/i.test(name)) || candidates[0];
  if (!preferred) {
    throw new Error(`No Creoveya installer found in ${distDir}`);
  }

  return path.join(distDir, preferred);
}

function main() {
  fs.mkdirSync(downloadsDir, { recursive: true });

  const source = findInstaller();
  const target = path.join(downloadsDir, 'CreoveyaSetup.exe');

  fs.copyFileSync(source, target);
  console.log(`Copied installer: ${source} -> ${target}`);
}

try {
  main();
} catch (error) {
  console.error('[copy-installer] Failed to copy installer:', error.message);
  process.exit(1);
}
