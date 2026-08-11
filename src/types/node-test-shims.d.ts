// Minimal ambient type shims for the handful of Node.js built-in APIs used
// by test-only files that read real files from disk as a mechanical check
// (platformPaths.test.ts scans public/; siteGate.test.ts reads index.ts's
// own source to verify its path lists). Deliberately NOT `@types/node` --
// this tsconfig scopes `types` to only `@cloudflare/workers-types` on
// purpose, and pulling in the full Node type package would declare `fetch`,
// `Request`, `Response`, etc. globally with Node's (incompatible) shapes,
// conflicting with the Workers ones used throughout the rest of the repo.
// These tests never run inside the Worker; they run under vitest's `node`
// environment (see vitest.config.ts), where the real Node.js runtime
// provides these functions at runtime -- this file only tells
// `tsc --noEmit` their shapes so the two test files above typecheck.

declare module "node:fs" {
  export function readFileSync(path: string, encoding: "utf8" | "utf-8"): string;
  export function readdirSync(path: string): string[];
}

declare module "node:path" {
  export function join(...segments: string[]): string;
  export function dirname(p: string): string;
  export function resolve(...segments: string[]): string;
  const defaultExport: {
    join: typeof join;
    dirname: typeof dirname;
    resolve: typeof resolve;
  };
  export default defaultExport;
}

declare module "node:url" {
  export function fileURLToPath(url: string | URL): string;
}

interface ImportMeta {
  url: string;
}
