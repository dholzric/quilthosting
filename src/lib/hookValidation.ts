/**
 * One validated hook path, shared by the admin webhook routes
 * (src/routes/outboundWebhooks.ts) and the public v1 hooks route
 * (src/routes/v1.ts). Before this module existed, the admin routes accepted
 * `http://` via a bare string-prefix check, never called validateHookUrl, and
 * PATCH wrote events_json with no validation at all -- trivially bypassing
 * the strict checks the v1 route already had. Both routes now call the same
 * function so they cannot drift apart again.
 */
import { validateHookUrl } from "./webhookOutbox";
import { WEBHOOK_SUBSCRIBE_OPTIONS } from "./webhookEvents";

/** Shared limit; was previously duplicated (only) in v1.ts. */
export const MAX_HOOKS_PER_TENANT = 25;

export type HookValidationInput = {
  /** Present for a create (required); omit on a PATCH not touching the URL. */
  url?: string;
  /**
   * Already defaulted by the caller (POST defaults missing/empty to ["*"]);
   * omit on a PATCH not touching events, since "not provided" and "clear to
   * nothing" are different intents that must not both mean ["*"].
   */
  events?: string[];
};

export type HookValidationOk = {
  ok: true;
  /** Trimmed URL, present only if `input.url` was provided. */
  url?: string;
  /** Present only if `input.events` was provided. */
  events?: string[];
};

export type HookValidationErr = {
  ok: false;
  error: string;
  code: "invalid_hook_url" | "unknown_event" | "hook_limit";
  status: 400 | 429;
  valid?: readonly string[];
};

export type HookValidationResult = HookValidationOk | HookValidationErr;

/**
 * Validates whichever of `url` / `events` is present in `input`, plus the
 * per-tenant hook limit when `opts.existingCount` is supplied.
 *
 * - `url`, when provided, must be an allowed https target per validateHookUrl
 *   (https required; loopback/private/link-local/metadata/self-domain denied).
 * - `events`, when provided, must be entirely drawn from
 *   WEBHOOK_SUBSCRIBE_OPTIONS -- an unknown name is rejected outright, never
 *   silently filtered (a typo would otherwise create a subscription that
 *   never fires and looks identical to a dead emitter).
 * - `opts.existingCount`, when supplied, enforces MAX_HOOKS_PER_TENANT. This
 *   is only meaningful for a create; PATCH call sites omit it entirely so an
 *   edit to an existing hook is never blocked by the tenant's hook count.
 */
export function validateHookInput(
  input: HookValidationInput,
  opts: { existingCount?: number } = {}
): HookValidationResult {
  let url: string | undefined;
  if (input.url !== undefined) {
    url = input.url.trim();
    const urlError = validateHookUrl(url);
    if (urlError) {
      return { ok: false, error: urlError, code: "invalid_hook_url", status: 400 };
    }
  }

  let events: string[] | undefined;
  if (input.events !== undefined) {
    const unknown = input.events.filter(
      (e) => !WEBHOOK_SUBSCRIBE_OPTIONS.includes(e)
    );
    if (unknown.length) {
      return {
        ok: false,
        error: `Unknown event(s): ${unknown.join(", ")}`,
        code: "unknown_event",
        status: 400,
        valid: WEBHOOK_SUBSCRIBE_OPTIONS,
      };
    }
    events = input.events;
  }

  if (
    opts.existingCount !== undefined &&
    opts.existingCount >= MAX_HOOKS_PER_TENANT
  ) {
    return {
      ok: false,
      error: `Limit of ${MAX_HOOKS_PER_TENANT} hooks reached`,
      code: "hook_limit",
      status: 429,
    };
  }

  return { ok: true, url, events };
}
