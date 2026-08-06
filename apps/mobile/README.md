# QuiltHosting native apps (iOS & Android)

Expo (React Native) client for **member portal** and **admin check-in**.

## Requirements

- Node 20+
- [Expo CLI](https://docs.expo.dev/) / EAS for store builds
- Apple Developer + Google Play accounts for production App Store / Play Store

## Setup

```bash
cd apps/mobile
npm install
npx expo start
```

Press `i` for iOS simulator, `a` for Android emulator, or scan the QR with Expo Go.

### API URL

Default production API: `https://quilthosting.com` (`app.json` → `extra.apiUrl`).

For local API:

```bash
# app.json extra.apiUrl → http://YOUR_LAN_IP:8787
```

**Private preview:** the site gate still applies to HTML; JSON APIs accept `Authorization: Bearer` once you have a session. For gated environments, complete site access on web first or set the same password flow on a native WebView if needed.

## Features

| Mode | Screens |
|------|---------|
| **Member** | Guild slug + email, magic-link hand-off, profile/status, events list |
| **Admin** | Dashboard stats, upcoming events, **event check-in** (search + one-tap) |

Deep link scheme: `quilthosting://` (auth token hand-off: `quilthosting://auth?token=…` — wire in a follow-up if needed).

## Store builds (EAS)

```bash
npm i -g eas-cli
eas login
eas build:configure
# set extra.eas.projectId in app.json
eas build --platform ios
eas build --platform android
```

Bundle IDs:

- iOS: `com.quiltmap.quilthosting`
- Android: `com.quiltmap.quilthosting`

## Relation to PWA

The responsive web **PWA** remains available for install from the browser. These native apps provide App Store / Play Store presence and a dedicated check-in workflow offline-friendly UI (queue can be added next).

## Stealth

Do **not** submit to public stores until the product gate is removed and legal/support are ready. Internal TestFlight / internal Play testing is fine while stealth.
