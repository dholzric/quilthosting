# Native iOS & Android apps

Source: **`apps/mobile/`** (Expo / React Native).

## What ships

- **Member mode** — guild slug, session token, profile, events  
- **Admin mode** — stats tiles, event list, **check-in** with search  
- Bundle IDs: `com.quiltmap.quilthosting`  

## Build

```bash
cd apps/mobile
npm install
npx expo start          # Expo Go / simulators
eas build -p ios        # after eas configure + Apple team
eas build -p android
```

See [apps/mobile/README.md](../apps/mobile/README.md).

## Stealth

Keep TestFlight / internal Play tracks only until the site gate is removed.

## Build gotchas (verified on a Galaxy Note 10+, Aug 2026)

1. **Keep Expo packages aligned.** Installing a package ad-hoc (e.g.
   `npm install expo-asset`) can pull an `expo-modules-core` that doesn't match
   SDK 52 and the Gradle build then fails with
   `Plugin [id: 'expo-module-gradle-plugin'] was not found`.
   Fix: `npx expo install --fix` then `npx expo prebuild --platform android --clean`.

2. **Kotlin ↔ Compose Compiler must match.** `expo-modules-core` maps
   Kotlin 1.9.24 → Compose 1.5.14 and 1.9.25 → 1.5.15. If the build reports a
   mismatch, set the matching value in `android/gradle.properties`:
   `android.kotlinVersion=1.9.25`
   (`android/` is gitignored, so re-add this after every `prebuild --clean`.)

3. **Adding a native module means rebuilding the APK** — a JS-only install
   gives `Cannot find native module 'ExpoAsset'` at runtime.

4. **Restart Metro with `--clear` after dependency changes**, otherwise the
   stale module map yields `Unable to resolve module ../Utilities/Platform`.

Local run: `npx expo run:android` (JAVA_HOME → Android Studio's bundled JBR,
ANDROID_HOME → the SDK), then `adb reverse tcp:8081 tcp:8081`.

## iOS headless builds (verified Aug 2026)

Building and installing to a device over SSH works — no Xcode GUI needed —
but three things must be right:

1. **Use the team ID from the provisioning profile, not the certificate name.**
   `security find-identity` shows `Apple Development: name (H8D2FSM65N)`; that
   parenthetical is *not* necessarily the team that owns the app. Read the real
   one from the profile:
   ```bash
   security cms -D -i ~/Library/Developer/Xcode/UserData/Provisioning\ Profiles/*.mobileprovision \
     | plutil -extract Entitlements.application-identifier raw -
   ```
   For QuiltHosting the team is **386RBGEN46**. Passing the wrong one yields the
   misleading `No Account for Team` / `No profiles were found` pair.

2. **Profiles live in `~/Library/Developer/Xcode/UserData/Provisioning Profiles/`**
   on Xcode 16+, not the legacy `~/Library/MobileDevice/Provisioning Profiles/`.

3. **codesign needs keychain partition access**, or framework signing fails with
   `errSecInternalComponent`. Unlocking alone is not enough:
   ```bash
   security unlock-keychain -p "$PW" ~/Library/Keychains/login.keychain-db
   security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$PW" \
     ~/Library/Keychains/login.keychain-db
   ```

Full working sequence (run as `apple` on the Mac):
```bash
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
export PATH=/opt/homebrew/opt/ruby@3.3/bin:/opt/homebrew/bin:$PATH
cd ~/qh-mobile/mobile/ios
xcodebuild -workspace QuiltHosting.xcworkspace -scheme QuiltHosting \
  -configuration Debug -destination "id=<device-udid>" \
  DEVELOPMENT_TEAM=386RBGEN46 -allowProvisioningUpdates build
xcrun devicectl device install app --device <device-udid> \
  ~/Library/Developer/Xcode/DerivedData/QuiltHosting-*/Build/Products/Debug-iphoneos/QuiltHosting.app
```
