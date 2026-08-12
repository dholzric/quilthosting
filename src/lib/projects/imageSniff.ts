// Decide an uploaded file's type from its BYTES, never from the client's
// Content-Type header. P0 learned this the expensive way: fileRoutes accepts
// whatever Content-Type a caller sends, so a text/html file could be stored
// and later echoed back on the tenant's own first-party origin — stored XSS.
// /img/:fileId now allowlists image types on the way out; this allowlists on
// the way in, so the bad bytes never land in R2 at all.
//
// SVG is deliberately absent. It is active content — it can carry inline
// <script> — and would reopen exactly that hole despite its image-y name.

function startsWith(bytes: Uint8Array, sig: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + sig.length) return false;
  for (let i = 0; i < sig.length; i++) {
    if (bytes[offset + i] !== sig[i]) return false;
  }
  return true;
}

function ascii(s: string): number[] {
  return Array.from(s, (ch) => ch.charCodeAt(0));
}

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG = [0xff, 0xd8, 0xff];

export function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes.length < 12) return null;

  if (startsWith(bytes, PNG)) return "image/png";
  if (startsWith(bytes, JPEG)) return "image/jpeg";
  if (startsWith(bytes, ascii("GIF87a")) || startsWith(bytes, ascii("GIF89a"))) {
    return "image/gif";
  }
  // RIFF....WEBP — the fourcc at offset 8 is load-bearing; a bare "RIFF" is
  // also how WAV and AVI start.
  if (startsWith(bytes, ascii("RIFF")) && startsWith(bytes, ascii("WEBP"), 8)) {
    return "image/webp";
  }
  // ISO-BMFF: "ftyp" at offset 4, brand at offset 8.
  if (startsWith(bytes, ascii("ftyp"), 4)) {
    if (startsWith(bytes, ascii("avif"), 8) || startsWith(bytes, ascii("avis"), 8)) {
      return "image/avif";
    }
  }
  return null;
}
