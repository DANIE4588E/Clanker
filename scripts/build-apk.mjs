#!/usr/bin/env node
/**
 * Builds release Android APKs locally and copies them into `builds/` (outside `android/`), named
 * after `app.json` (`expo.version`): one per CPU ABI, `clanker-<version>-<abi>.apk`, plus the
 * universal `clanker-<version>.apk` that runs anywhere. With `--arch`, Gradle builds just those
 * ABIs into a single APK instead (named with the ABI when it is only one).
 * Existing files in `builds/` are never overwritten unless `--overwrite` is passed.
 *
 * Every APK is checked with `apksigner verify --print-certs` before it is copied, and the build
 * is refused when one is signed with the public React Native debug key, which anyone can use to
 * sign an APK Android would accept as a Clanker update. Set up a release key first (README,
 * "Release signing"); `--allow-debug-key` skips the refusal, for one final transitional release.
 * The keystore passwords are passed on to Gradle from .env.local (CLANKER_RELEASE_*).
 *
 * Usage:
 *   npm run build:apk
 *   npm run build:apk -- --arch arm64-v8a
 *   npm run build:apk -- --skip-prebuild --install
 *   npm run build:apk -- --out D:\ClankerBuilds
 *   npm run build:apk -- --preview      (installs beside the regular app; see app.config.js)
 *   npm run build:apk -- --allow-debug-key
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import util from 'node:util';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ANDROID_DIR = path.join(ROOT, 'android');
const RELEASE_DIR = path.join(ANDROID_DIR, 'app', 'build', 'outputs', 'apk', 'release');
const IS_WIN = process.platform === 'win32';
/** Records which variant android/ was generated for; switching variants needs a clean prebuild. */
const VARIANT_MARKER = path.join(ANDROID_DIR, '.clanker-variant');
/** SHA-256 of the React Native template's debug.keystore certificate, which is public. */
const DEBUG_KEY_SHA256 = 'fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c';
/** The ABIs split APKs are built for (plugins/withAndroidRelease.js, from reactNativeArchitectures). */
const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64', 'x86'];

function printHelp() {
  console.log(`Build local Clanker release APKs: clanker-<version>-<abi>.apk for each CPU ABI,
plus the universal clanker-<version>.apk.

Usage:
  node scripts/build-apk.mjs [options]
  npm run build:apk -- [options]

Options:
  --out <dir>        Output directory (default: ./builds or CLANKER_BUILD_DIR)
  --arch <abis>      Gradle reactNativeArchitectures override (e.g. arm64-v8a); builds one APK
                     for those ABIs instead of per-ABI APKs
  --skip-prebuild    Skip \`npx expo prebuild --platform android\`
  --clean            Run \`npx expo prebuild --platform android --clean\`
  --no-minify        Do not pass -Pandroid.enableMinifyInReleaseBuilds=true
  --overwrite        Overwrite existing APKs of the same names instead of numbering them (-2, -3, ...)
  --preview          Build "Clanker Preview", a separate app that installs beside the
                     regular one (own package id and data); saved as clanker-preview-<version>*.apk
  --install          Run \`adb install -r\` on the APK for the connected device's ABI after copying
  --allow-debug-key  Copy APKs even when they are signed with the public debug key (for one final
                     transitional release before switching to a release key; see README)
  --dry-run          Print planned commands and output paths without building
  -h, --help         Show this help message

Release signing: set CLANKER_RELEASE_STORE_FILE, CLANKER_RELEASE_KEY_ALIAS,
CLANKER_RELEASE_STORE_PASSWORD and CLANKER_RELEASE_KEY_PASSWORD in .env.local (see README).
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
    preview: false,
    allowDebugKey: false,
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
    else if (arg === '--preview') opts.preview = true;
    else if (arg === '--allow-debug-key') opts.allowDebugKey = true;
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

/**
 * Destination paths for a set of APKs (`abi` null for the universal or single one), numbered
 * together (-2, -3, ...) so one build's files share a suffix and none overwrites an older file.
 */
function resolveOutputPaths(outDir, version, overwrite, preview, outputs) {
  const safeVersion = version.replace(/[^a-zA-Z0-9._+-]/g, '-');
  const baseName = `clanker-${preview ? 'preview-' : ''}${safeVersion}`;
  for (let n = 1; ; n++) {
    const paths = outputs.map((o) => path.join(outDir, `${baseName}${n > 1 ? `-${n}` : ''}${o.abi ? `-${o.abi}` : ''}.apk`));
    if (overwrite || paths.every((p) => !fs.existsSync(p))) return paths;
  }
}

function run(command, args, { cwd = ROOT, dryRun = false, env } = {}) {
  const display = `${command} ${args.join(' ')}`.trim();
  console.log(`\n> (${path.relative(ROOT, cwd) || '.'}) ${display}`);
  if (dryRun) return;

  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: env ?? process.env,
    shell: IS_WIN && /\.(cmd|bat)$/i.test(command),
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Command failed with exit code ${result.status}: ${display}`);
  }
}

/**
 * CLANKER_RELEASE_* variables from the project's .env files, for Gradle (which doesn't read them,
 * unlike Expo CLI). Uses the same files and order as `expo prebuild`; the shell's own values win.
 */
async function releaseSigningEnv() {
  let env = {};
  try {
    const expoEnv = await import('@expo/env');
    const parseProjectEnv = expoEnv.parseProjectEnv ?? expoEnv.default?.parseProjectEnv;
    env = parseProjectEnv(ROOT, { mode: 'development', silent: true }).env;
  } catch {
    // Highest priority last, so it wins.
    for (const name of ['.env', '.env.development', '.env.local', '.env.development.local']) {
      const file = path.join(ROOT, name);
      if (fs.existsSync(file) && util.parseEnv) Object.assign(env, util.parseEnv(fs.readFileSync(file, 'utf8')));
    }
  }
  const picked = {};
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith('CLANKER_RELEASE_') && process.env[key] === undefined) picked[key] = value;
  }
  return picked;
}

function androidSdkDirs() {
  const dirs = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];
  const localProps = path.join(ANDROID_DIR, 'local.properties');
  if (fs.existsSync(localProps)) {
    const line = fs.readFileSync(localProps, 'utf8').match(/^\s*sdk\.dir\s*=\s*(.+)$/m);
    if (line) dirs.push(line[1].trim().replace(/\\:/g, ':').replace(/\\\\/g, '\\'));
  }
  if (IS_WIN && process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'));
  else if (process.platform === 'darwin') dirs.push(path.join(os.homedir(), 'Library', 'Android', 'sdk'));
  else dirs.push(path.join(os.homedir(), 'Android', 'Sdk'));
  return dirs.filter(Boolean);
}

const compareVersions = (a, b) => {
  const pa = a.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = b.split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
};

/**
 * How to run apksigner from the newest SDK build-tools: its jar through Java where possible
 * (no .bat quoting trouble on Windows), else its launcher script. Null when there is none.
 */
function findApksigner() {
  const javaHome = process.env.JAVA_HOME;
  const java = javaHome ? path.join(javaHome, 'bin', IS_WIN ? 'java.exe' : 'java') : 'java';
  for (const sdk of androidSdkDirs()) {
    const buildTools = path.join(sdk, 'build-tools');
    if (!fs.existsSync(buildTools)) continue;
    const versions = fs.readdirSync(buildTools).sort(compareVersions).reverse();
    for (const version of versions) {
      const dir = path.join(buildTools, version);
      const jar = path.join(dir, 'lib', 'apksigner.jar');
      if (fs.existsSync(jar)) return { command: java, prefix: ['-jar', jar], display: jar };
      const script = path.join(dir, IS_WIN ? 'apksigner.bat' : 'apksigner');
      if (fs.existsSync(script)) return { command: script, prefix: [], display: script };
    }
  }
  return null;
}

/** The SHA-256 digests of an APK's signer certificates, from `apksigner verify --print-certs`. */
function signerDigests(apksigner, apk) {
  const args = [...apksigner.prefix, 'verify', '--print-certs', apk];
  const viaShell = IS_WIN && /\.bat$/i.test(apksigner.command);
  const result = viaShell
    ? spawnSync([apksigner.command, ...args].map((a) => `"${a}"`).join(' '), { shell: true, encoding: 'utf8' })
    : spawnSync(apksigner.command, args, { encoding: 'utf8' });
  if (result.error) throw new Error(`Could not run apksigner (${apksigner.display}): ${result.error.message}`);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
  if (result.status !== 0) throw new Error(`apksigner could not verify ${apk}:\n${output.trim()}`);
  const digests = [...output.matchAll(/certificate SHA-256 digest:\s*([0-9a-f]{64})/gi)].map((m) => m[1].toLowerCase());
  if (!digests.length) throw new Error(`apksigner printed no signer certificates for ${apk}:\n${output.trim()}`);
  return [...new Set(digests)];
}

/**
 * The APKs the last release build produced, from Gradle's output-metadata.json (so files left
 * over from an earlier build with other settings are ignored). `abi` is null for the universal
 * or single APK.
 */
function releaseOutputs() {
  const metadataPath = path.join(RELEASE_DIR, 'output-metadata.json');
  if (fs.existsSync(metadataPath)) {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    return (metadata.elements ?? [])
      .map((e) => ({
        file: path.join(RELEASE_DIR, e.outputFile),
        abi: (e.filters ?? []).find((f) => f.filterType === 'ABI')?.value ?? null,
      }))
      .filter((o) => fs.existsSync(o.file));
  }
  const single = path.join(RELEASE_DIR, 'app-release.apk');
  return fs.existsSync(single) ? [{ file: single, abi: null }] : [];
}

/** A single-ABI --arch build is named after its ABI; anything else is the universal name. */
function nameOutputs(outputs, arch) {
  const only = arch && !arch.includes(',') ? arch.trim() : null;
  return outputs.map((o) => (o.abi || outputs.length > 1 || !only ? o : { ...o, abi: only }));
}

/** The APK to install on the connected device: its primary ABI's, else the universal one. */
function pickForDevice(copies) {
  const result = spawnSync('adb', ['shell', 'getprop', 'ro.product.cpu.abi'], { encoding: 'utf8' });
  const abi = result.status === 0 ? (result.stdout ?? '').trim() : '';
  if (abi) console.log(`\nDevice ABI: ${abi}`);
  return copies.find((c) => c.abi === abi) ?? copies.find((c) => !c.abi) ?? copies[0];
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    return;
  }

  const version = readAppVersion();
  const variant = opts.preview ? 'preview' : 'release';
  // app.config.js reads APP_VARIANT during prebuild, and Gradle's bundling step reads the app config too.
  const env = { ...process.env, APP_VARIANT: variant };
  const signingEnv = await releaseSigningEnv();
  const splits = !opts.arch;
  const expected = nameOutputs(splits ? [...ABIS.map((abi) => ({ abi })), { abi: null }] : [{ abi: null }], opts.arch);
  const plannedPaths = resolveOutputPaths(opts.outDir, version, opts.overwrite, opts.preview, expected);

  const signedWith = { ...process.env, ...signingEnv }.CLANKER_RELEASE_STORE_FILE;
  console.log(`Clanker version : ${version}${opts.preview ? ' (preview)' : ''}`);
  console.log(`Output APKs     : ${plannedPaths.join('\n                  ')}`);
  console.log(`Release key     : ${signedWith ? signedWith : 'not set up (CLANKER_RELEASE_STORE_FILE); Gradle signs with the debug key'}`);

  // android/ generated for the other variant has the other package id baked in.
  const builtVariant = fs.existsSync(VARIANT_MARKER) ? fs.readFileSync(VARIANT_MARKER, 'utf8').trim() : 'release';
  const switching = fs.existsSync(ANDROID_DIR) && builtVariant !== variant;
  if (switching && opts.skipPrebuild) {
    throw new Error(`android/ was generated for the ${builtVariant} variant; drop --skip-prebuild to regenerate it.`);
  }

  if (!opts.skipPrebuild || !fs.existsSync(ANDROID_DIR)) {
    const prebuildArgs = ['expo', 'prebuild', '--platform', 'android'];
    if (opts.clean || switching) prebuildArgs.push('--clean');
    if (switching) console.log(`
Switching android/ from ${builtVariant} to ${variant}: regenerating it.`);
    run(IS_WIN ? 'npx.cmd' : 'npx', prebuildArgs, { cwd: ROOT, dryRun: opts.dryRun, env });
    if (!opts.dryRun) fs.writeFileSync(VARIANT_MARKER, variant);
  } else {
    console.log('\nSkipping expo prebuild (--skip-prebuild).');
  }

  const gradleCmd = IS_WIN ? 'gradlew.bat' : './gradlew';
  const gradleArgs = ['assembleRelease'];
  if (opts.minify) gradleArgs.push('-Pandroid.enableMinifyInReleaseBuilds=true');
  if (opts.arch) gradleArgs.push(`-PreactNativeArchitectures=${opts.arch}`);
  else gradleArgs.push('-PclankerAbiSplits=true');

  run(gradleCmd, gradleArgs, { cwd: ANDROID_DIR, dryRun: opts.dryRun, env: { ...env, ...signingEnv } });

  const apksigner = findApksigner();
  if (opts.dryRun) {
    console.log(`\n[dry-run] Would verify each APK's signer with: ${apksigner ? apksigner.display : 'apksigner (not found; the build would fail)'}`);
    console.log(
      opts.allowDebugKey
        ? '[dry-run] APKs signed with the public debug key would be copied anyway (--allow-debug-key).'
        : '[dry-run] APKs signed with the public debug key would be refused.'
    );
    console.log(`[dry-run] Would copy from ${RELEASE_DIR}:`);
    expected.forEach((o, i) => console.log(`  ${o.abi ?? 'universal'}: ${plannedPaths[i]}`));
    if (opts.install) console.log('[dry-run] Would run: adb install -r <the APK for the device ABI from `adb shell getprop ro.product.cpu.abi`>');
    return;
  }

  const outputs = nameOutputs(releaseOutputs(), opts.arch);
  if (!outputs.length) throw new Error(`No release APKs found in ${RELEASE_DIR}`);

  // Check every APK before copying any.
  if (!apksigner) {
    throw new Error(
      'apksigner was not found, so the APKs\' signatures could not be checked. Install the Android SDK build-tools ' +
        'or set ANDROID_HOME to the SDK.'
    );
  }
  const debugSigned = [];
  for (const o of outputs) {
    const digests = signerDigests(apksigner, o.file);
    console.log(`Signer of ${path.basename(o.file)}: ${digests.join(', ')}`);
    if (digests.includes(DEBUG_KEY_SHA256)) debugSigned.push(path.basename(o.file));
  }
  if (debugSigned.length) {
    const what = `${debugSigned.join(', ')} ${debugSigned.length > 1 ? 'are' : 'is'} signed with the public React Native debug key (SHA-256 ${DEBUG_KEY_SHA256})`;
    if (!opts.allowDebugKey) {
      throw new Error(
        `${what}. Anyone can sign an APK with that key, so Android would accept their APK as a Clanker update. ` +
          'Set up a release key (README, "Release signing") and build again, or pass --allow-debug-key for one final transitional release.'
      );
    }
    console.warn(`\nWARNING: ${what}. Copying anyway because of --allow-debug-key.`);
  }

  fs.mkdirSync(opts.outDir, { recursive: true });
  // Resolved again right before copying in case another build wrote the same names while Gradle ran.
  const finalPaths = resolveOutputPaths(opts.outDir, version, opts.overwrite, opts.preview, outputs);
  const copies = outputs.map((o, i) => {
    fs.copyFileSync(o.file, finalPaths[i]);
    const sizeMb = (fs.statSync(finalPaths[i]).size / (1024 * 1024)).toFixed(1);
    console.log(`Saved APK: ${finalPaths[i]} (${sizeMb} MB)`);
    return { abi: o.abi, path: finalPaths[i] };
  });

  if (opts.install) {
    const chosen = copies.length > 1 ? pickForDevice(copies) : copies[0];
    run('adb', ['install', '-r', chosen.path], { cwd: ROOT });
  }
}

main().catch((err) => {
  console.error(`\nBuild failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
