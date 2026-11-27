This is an Expo/React Native mobile application. Prioritize mobile-first patterns, performance, and cross-platform compatibility.

## Expo has changed — do not trust your training data

Expo ships breaking changes every SDK release. APIs you remember are likely renamed, moved, or removed. Before writing any code that touches an Expo, EAS, or React Native API:

1. Read the major version of the `expo` package in `package.json`.
2. Fetch the matching versioned docs: `https://docs.expo.dev/versions/v<major>.0.0/`
3. For anything else, fetch https://docs.expo.dev/llms.txt — an index of all Expo docs with corrections to common LLM misconceptions. Follow its links to the specific page you need; never answer from memory.

## Commands

Use `bunx` instead of `npx` if the project uses bun (`bun.lock` present).

```bash
npx expo install <package>  # ALWAYS use instead of npm/yarn/pnpm/bun add — resolves SDK-compatible versions
npx expo start              # start the dev server
npx expo lint               # lint
npx tsc --noEmit            # typecheck
npx expo-doctor             # diagnose dependency and config issues
npx expo install --fix      # fix incompatible package versions
```

Run lint and typecheck before declaring any task done.

## Dev builds on a device: always use the preview variant

Never install a test build over the user's real Clanker app (`com.danie4588e.Clanker`). It would convert their chats and settings to whatever format your branch writes, and an older build may not read that format back. Build the **preview** variant instead. It has its own package id (`com.danie4588e.Clanker.preview`), its own data and the name "Clanker Preview" (see `app.config.js`).

Don't use `npx expo run:android` for this either: it installs over adb and starts an emulator when no phone is connected. Build the APK with Gradle; the user installs it on the phone by tapping it (no adb, no emulator).

**1. Build the preview dev APK** (in one PowerShell window, from the project root; replace `<version>` with `expo.version` from `app.json`):

```powershell
$env:APP_VARIANT = 'preview'
npx expo prebuild --platform android --clean
Select-String -Path android\app\build.gradle -Pattern 'applicationId'   # must say com.danie4588e.Clanker.preview
cd android
.\gradlew.bat assembleDebug
cd ..
Copy-Item android\app\build\outputs\apk\debug\app-debug.apk builds\clanker-preview-dev-<version>.apk
```

In Bash, prefix each `npx expo` command with `APP_VARIANT=preview` and run `./gradlew assembleDebug` in `android/`.

The variant is fixed into `android/` when `prebuild` runs. If `APP_VARIANT` wasn't set then, `android/` gets the normal package id, and the APK would replace the user's real app. Always check `applicationId` before building, and run `prebuild --clean` again if it's wrong.

**2. Install:** the user copies `builds\clanker-preview-dev-<version>.apk` to the phone (USB file transfer, cloud drive, and so on) and taps it. It installs over Clanker Preview and leaves the normal app alone.

**3. Serve the JavaScript:** it's a dev-client build, so it loads its JS from the PC over Wi-Fi. In the same window, with `APP_VARIANT` still set, run `npx expo start`. The phone and PC must be on the same Wi-Fi network. On the phone, open Clanker Preview and pick the server, or scan the QR code that `expo start` prints. Windows may ask to allow Node through the firewall; it needs private networks. When you're done, `Remove-Item Env:APP_VARIANT`, since the variable stays set for the whole session.

- **Standalone APK** (no PC or dev server needed, no live reload): `npm run build:apk -- --preview --allow-debug-key` writes `builds\clanker-preview-<version>-<abi>.apk`. It sets `APP_VARIANT` itself. `--allow-debug-key` keeps it on the same key as earlier preview builds so it installs over them. That only works while no `CLANKER_RELEASE_*` signing variables are set in `.env.local`; with them set, it's signed with the release key and won't install over a debug-signed preview.
- **Testing an upgrade or migration** (storage format, secrets moving to SecureStore, and so on): a fresh preview install starts empty. The user first installs an older `clanker-preview-dev-*.apk` from `builds/` the same way and creates the data the migration touches. Then they install the new build over it: same package, same debug key.
- **Shared links:** both variants share the `clanker://` scheme. With both installed, Android may ask which app opens a bridge pairing link or finishes a sign-in: choose Clanker Preview while testing.

## Navigation & Routing

- Use **Expo Router** for all navigation. Routes live in `src/app/` — every file there is a screen, `_layout.tsx` files define navigators. Keep non-route code (components, hooks, utils) outside `src/app/`.
- Import `Link`, `router`, and `useLocalSearchParams` from `expo-router`.
- Docs: https://docs.expo.dev/router/introduction.md

## Building with EAS

Use EAS to build, sign, and submit the app in the cloud (`eas build`, `eas submit`) and to ship over-the-air updates (`eas update`) — no local Xcode or Android Studio required. Run EAS CLI as `bunx eas-cli <command>` in Bun projects, or `npx eas-cli@latest <command>` otherwise; substitute that for bare `eas` in docs examples.
Docs: https://docs.expo.dev/eas/index.md

## Rules

- If `ios/` and `android/` directories do not exist, they are generated (Continuous Native Generation). Never create or edit them by hand — configure native behavior in `app.json` and config plugins.
- Expo Go only includes its bundled native modules. After adding a library with native code, the app needs a development build: `npx expo run:ios` locally (on Android, the preview dev APK above), or `eas build --profile development`.
- Prefer recommended Expo modules over third-party libraries, and check your available skills before adding dependencies. Docs: https://docs.expo.dev/versions/latest/index.md
