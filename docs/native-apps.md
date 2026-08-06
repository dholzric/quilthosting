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
