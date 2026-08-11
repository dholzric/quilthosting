/**
 * Single source of truth for the app version.
 * Keep in sync with package.json when cutting a release — the API and every
 * page footer read from here so they can never drift apart again.
 */
export const APP_VERSION = "0.32.0-preview";
