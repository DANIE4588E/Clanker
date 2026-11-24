#!/usr/bin/env node
/**
 * Builds a release Android APK locally and copies it into `builds/` (outside `android/`)
 * named `clanker-<version>.apk` based on `app.json` (`expo.version`).
 * Existing files in `builds/` are never overwritten unless `--overwrite` is passed.
 *
 * Usage:
 *   npm run build:apk
 *   npm run build:apk -- --arch arm64-v8a
 *   npm run build:apk -- --skip-prebuild --install
 *   npm run build:apk -- --out D:\ClankerBuilds
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(ROOT, 'android');
const RELEASE_APK = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const IS_WIN = process.platform === 'win32';

function printHelp() {
  console.log(`Build a local Clanker release APK and archive it as clanker-<version>.apk.

Usage:
  node scripts/build-apk.mjs [options]
  npm run build:apk -- [options]

Options:
  --out <dir>        Output directory (default: ./builds or CLANKER_BUILD_DIR)
  --arch <abis>      Gradle reactNativeArchitectures override (e.g. arm64-v8a)
  --skip-prebuild    Skip \`npx expo prebuild --platform android\`
  --clean            Run \`npx expo prebuild --platform android --clean\`
  --no-minify        Do not pass -Pandroid.enableMinifyInReleaseBuilds=true
  --overwrite        Overwrite clanker-<version>.apk if it already exists
  --install          Run \`adb install -r\` on the built APK after copying
  --dry-run          Print planned commands and output path without building
  -h, --help         Show this help message
`);
}

function parseArgs(argv) {
  const opts = {
    outDir: process.env.CLANKER_BUILD_DIR || path.join(ROOT, 'builds'),
    arch: undefined,
    skipPrebuild: false,
    clean: false,
    minify: true,
    overwrite: false,
    install: false,
    dryRun: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') opts.help = true;
    else if (arg === '--skip-prebuild') opts.skipPrebuild = true;
    else if (arg === '--clean') opts.clean = true;
    else if (arg === '--no-minify') opts.minify = false;
    else if (arg === '--overwrite') opts.overwrite = true;
    else if (arg === '--install') opts.install = true;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--out' || arg.startsWith('--out=')) {
      const value = arg.includes('=') ? arg.slice('--out='.length) : argv[++i];
      if (!value) throw new Error('--out requires a directory path.');
      opts.outDir = path.resolve(ROOT, value);
    } else if (arg === '--arch' || arg.startsWith('--arch=')) {
      const value = arg.includes('=') ? arg.slice('--arch='.length) : argv[++i];
      if (!value) throw new Error('--arch requires an ABI value (e.g. arm64-v8a).');
      opts.arch = value;
    } else {
      throw new Error(`Unknown option: ${arg} (use --help for usage)`);
    }
  }
  if (opts.skipPrebuild && opts.clean) {
    throw new Error('Cannot combine --skip-prebuild and --clean.');
  }
  return opts;
}

function readAppVersion() {
  const appJsonPath = path.join(ROOT, 'app.json');
  const raw = fs.readFileSync(appJsonPath, 'utf8');
  const parsed = JSON.parse(raw);
  const version = parsed?.expo?.version;
  if (typeof version !== 'string' || !version.trim()) {
    throw new Error(`Could not read expo.version from ${appJsonPath}`);
  }
  return version.trim();
}

function resolveOutputPath(outDir, version, overwrite) {
  const safeVersion = version.replace(/[^a-zA-Z0-9._+-]/g, '-');
  const baseName = `clanker-${safeVersion}`;
  let candidate = path.join(outDir, `${baseName}.apk`);
  if (overwrite || !fs.existsSync(candidate)) return candidate;

  for (let n = 2; ; n++) {
    candidate = path.join(outDir, `${baseName}-${n}.apk`);
    if (!fs.existsSync(candidate)) return candidate;
  }
}

function run(command, args, { cwd = ROOT, dryRun = false } = {}) {
  const display = `${command} ${args.join(' ')}`.trim();
  console.log(`\n> (${path.relative(ROOT, cwd) || '.'}) ${display}`);
  if (dryRun) return;

  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: IS_WIN && /\.(cmd|bat)$/i.test(command),
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status}: ${display}`);
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const version = readAppVersion();
  const destPath = resolveOutputPath(opts.outDir, version, opts.overwrite);

  console.log(`Clanker version : ${version}`);
  console.log(`Output APK      : ${destPath}`);

  if (!opts.skipPrebuild || !fs.existsSync(ANDROID_DIR)) {
    const prebuildArgs = ['expo', 'prebuild', '--platform', 'android'];
    if (opts.clean) prebuildArgs.push('--clean');
    run(IS_WIN ? 'npx.cmd' : 'npx', prebuildArgs, { cwd: ROOT, dryRun: opts.dryRun });
  } else {
    console.log('\nSkipping expo prebuild (--skip-prebuild).');
  }

  const gradleCmd = IS_WIN ? 'gradlew.bat' : './gradlew';
  const gradleArgs = ['assembleRelease'];
  if (opts.minify) gradleArgs.push('-Pandroid.enableMinifyInReleaseBuilds=true');
  if (opts.arch) gradleArgs.push(`-PreactNativeArchitectures=${opts.arch}`);

  run(gradleCmd, gradleArgs, { cwd: ANDROID_DIR, dryRun: opts.dryRun });

  if (opts.dryRun) {
    console.log(`\n[dry-run] Would copy:\n  from: ${RELEASE_APK}\n  to:   ${destPath}`);
    if (opts.install) console.log(`[dry-run] Would run: adb install -r "${destPath}"`);
    return;
  }

  if (!fs.existsSync(RELEASE_APK)) {
    throw new Error(`Expected release APK not found at ${RELEASE_APK}`);
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  // Re-resolve right before copying in case another build wrote the same name while Gradle ran.
  const finalPath = resolveOutputPath(opts.outDir, version, opts.overwrite);
  fs.copyFileSync(RELEASE_APK, finalPath);

  const sizeMb = (fs.statSync(finalPath).size / (1024 * 1024)).toFixed(1);
  console.log(`\nSaved APK: ${finalPath} (${sizeMb} MB)`);

  if (opts.install) {
    run('adb', ['install', '-r', finalPath], { cwd: ROOT });
  }
}

try {
  main();
} catch (err) {
  console.error(`\nBuild failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
