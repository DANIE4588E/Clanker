/**
 * Release build settings for android/app/build.gradle, which `expo prebuild` regenerates (so they
 * can't be edited there by hand).
 *
 * Signing: when CLANKER_RELEASE_STORE_FILE and CLANKER_RELEASE_KEY_ALIAS are set (in .env.local,
 * which Expo CLI loads for prebuild, or the shell), release builds are signed with that keystore
 * instead of the public React Native debug key. Only the keystore path and alias are written into
 * build.gradle; the passwords are read when Gradle runs, from CLANKER_RELEASE_STORE_PASSWORD and
 * CLANKER_RELEASE_KEY_PASSWORD in the environment (scripts/build-apk.mjs passes them on from
 * .env.local) or Gradle properties of the same names (e.g. ~/.gradle/gradle.properties). Without
 * the variables nothing changes, so development builds work as before. See README "Release signing".
 *
 * ABI splits: a release built with -PclankerAbiSplits=true also produces one APK per CPU ABI
 * (app-<abi>-release.apk) beside the universal one (app-universal-release.apk). Off by default,
 * so `expo run:android` and other builds keep producing a single APK.
 */
const fs = require('node:fs');
const path = require('node:path');
const { withAppBuildGradle } = require('expo/config-plugins');

const SIGNING_TAG = '// @clanker release-signing';
const SPLITS_TAG = '// @clanker abi-splits';

/** A Groovy single-quoted string literal. */
const groovyString = (value) => `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;

function addSigning(contents, { storeFile, keyAlias }) {
  if (contents.includes(SIGNING_TAG)) return contents;

  const signingBlock = /(\n([ \t]*)signingConfigs\s*\{\n)/;
  const match = contents.match(signingBlock);
  if (!match) throw new Error('withAndroidRelease: no signingConfigs block in android/app/build.gradle.');
  const indent = match[2];
  const inner = `${indent}    `;
  const release = [
    `${inner}${SIGNING_TAG}: passwords come from the environment or Gradle properties when Gradle runs.`,
    `${inner}release {`,
    `${inner}    storeFile file(${groovyString(storeFile)})`,
    `${inner}    storePassword clankerSigningSecret('CLANKER_RELEASE_STORE_PASSWORD')`,
    `${inner}    keyAlias ${groovyString(keyAlias)}`,
    `${inner}    keyPassword clankerSigningSecret('CLANKER_RELEASE_KEY_PASSWORD')`,
    `${inner}}`,
    '',
  ].join('\n');
  let next = contents.replace(signingBlock, `$1${release}`);

  // buildTypes { ... release { ... signingConfig signingConfigs.debug
  const releaseSigning = /(buildTypes\s*\{[\s\S]*?\n\s*release\s*\{[\s\S]*?signingConfig\s+)signingConfigs\.debug/;
  if (!releaseSigning.test(next)) throw new Error('withAndroidRelease: no release build type signed with the debug key to switch over.');
  next = next.replace(releaseSigning, '$1signingConfigs.release');

  // Read lazily, and only fail for a build that actually packages a release APK, so syncing the
  // project or building debug works without the passwords.
  const helper = [
    SIGNING_TAG,
    'def clankerSigningSecret = { String name ->',
    '    def value = System.getenv(name) ?: findProperty(name)',
    '    return value ? value.toString() : null',
    '}',
    'gradle.taskGraph.whenReady { graph ->',
    "    def packagesRelease = graph.allTasks.any { it.project == project && it.name ==~ /package\\w*Release/ }",
    "    def missing = ['CLANKER_RELEASE_STORE_PASSWORD', 'CLANKER_RELEASE_KEY_PASSWORD'].findAll { !clankerSigningSecret(it) }",
    '    if (packagesRelease && missing) {',
    '        throw new GradleException("Release signing is set up, but ${missing.join(\' and \')} " +',
    '            "is not set. Put it in .env.local and build with scripts/build-apk.mjs, export it, or pass -P${missing[0]}=...")',
    '    }',
    '}',
    '',
  ].join('\n');
  return next.replace(/\nandroid\s*\{/, `\n${helper}android {`);
}

function addSplits(contents) {
  if (contents.includes(SPLITS_TAG)) return contents;
  const block = [
    `    ${SPLITS_TAG}: per-ABI APKs plus a universal one, only when built with -PclankerAbiSplits=true.`,
    '    splits {',
    '        abi {',
    "            enable((findProperty('clankerAbiSplits') ?: 'false').toBoolean())",
    '            reset()',
    "            include(*((findProperty('reactNativeArchitectures') ?: 'armeabi-v7a,arm64-v8a,x86,x86_64').split(',').collect { it.trim() }))",
    '            universalApk true',
    '        }',
    '    }',
    '',
  ].join('\n');
  // Right before packagingOptions, inside the android block.
  const anchor = /\n([ \t]*)packagingOptions\s*\{/;
  if (!anchor.test(contents)) throw new Error('withAndroidRelease: no packagingOptions block in android/app/build.gradle.');
  return contents.replace(anchor, (m) => `\n${block}${m.slice(1)}`);
}

module.exports = function withAndroidRelease(config) {
  return withAppBuildGradle(config, (cfg) => {
    if (cfg.modResults.language !== 'groovy') {
      throw new Error('withAndroidRelease: android/app/build.gradle is expected to be Groovy.');
    }
    const projectRoot = cfg.modRequest.projectRoot;
    let contents = cfg.modResults.contents;

    const storeFile = (process.env.CLANKER_RELEASE_STORE_FILE ?? '').trim();
    const keyAlias = (process.env.CLANKER_RELEASE_KEY_ALIAS ?? '').trim();
    if (storeFile && keyAlias) {
      // Absolute, with forward slashes, since Gradle resolves file() against android/app.
      const resolved = path.resolve(projectRoot, storeFile).replace(/\\/g, '/');
      if (!fs.existsSync(resolved)) {
        console.warn(`withAndroidRelease: CLANKER_RELEASE_STORE_FILE points at ${resolved}, which doesn't exist (yet).`);
      }
      contents = addSigning(contents, { storeFile: resolved, keyAlias });
    } else if (storeFile || keyAlias) {
      console.warn('withAndroidRelease: set both CLANKER_RELEASE_STORE_FILE and CLANKER_RELEASE_KEY_ALIAS to sign releases; using the debug key.');
    }

    contents = addSplits(contents);
    cfg.modResults.contents = contents;
    return cfg;
  });
};
