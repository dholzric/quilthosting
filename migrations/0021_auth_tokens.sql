-- P0 auth: one-time magic-link tokens.
-- Each magic link's JWT `jti` is recorded here when issued and consumed by a
-- single conditional UPDATE (used_at IS NULL AND expires_at > now) on first
-- use, so a link cannot be replayed within its 15-minute signature validity.
-- No FK to users: the row is written in the same request that may create the
-- user, and sweepAuthTokens() prunes expired rows from the daily cron.

CREATE TABLE IF NOT EXISTS auth_tokens (
  jti TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  purpose TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires_at ON auth_tokens (expires_at);
