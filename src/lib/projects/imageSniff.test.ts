import { describe, it, expect } from "vitest";
import { sniffImageType } from "./imageSniff";

function bytes(...vals: number[]): Uint8Array {
  const out = new Uint8Array(64);
  out.set(vals);
  return out;
}
function ascii(s: string, offset = 0): Uint8Array {
  const out = new Uint8Array(64);
  for (let i = 0; i < s.length; i++) out[offset + i] = s.charCodeAt(i);
  return out;
}

describe("sniffImageType", () => {
  it("detects PNG", () => {
    expect(sniffImageType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))).toBe("image/png");
  });

  it("detects JPEG", () => {
    expect(sniffImageType(bytes(0xff, 0xd8, 0xff, 0xe0))).toBe("image/jpeg");
  });

  it("detects GIF87a and GIF89a", () => {
    expect(sniffImageType(ascii("GIF87a"))).toBe("image/gif");
    expect(sniffImageType(ascii("GIF89a"))).toBe("image/gif");
  });

  it("detects WebP (RIFF container with a WEBP fourcc)", () => {
    const b = ascii("RIFF");
    b.set(ascii("WEBP").subarray(0, 4), 8);
    expect(sniffImageType(b)).toBe("image/webp");
  });

  it("detects AVIF (ftyp box)", () => {
    const b = ascii("ftyp", 4);
    b.set(ascii("avif").subarray(0, 4), 8);
    expect(sniffImageType(b)).toBe("image/avif");
  });

  it("REFUSES SVG even though its MIME type looks image-y", () => {
    expect(sniffImageType(ascii("<svg xmlns="))).toBe(null);
    expect(sniffImageType(ascii("<?xml version=\"1.0\"?><svg"))).toBe(null);
  });

  it("refuses HTML, which is the stored-XSS case that matters", () => {
    expect(sniffImageType(ascii("<!DOCTYPE html><script>"))).toBe(null);
  });

  it("refuses a RIFF container that is not WebP (e.g. a WAV)", () => {
    const b = ascii("RIFF");
    b.set(ascii("WAVE").subarray(0, 4), 8);
    expect(sniffImageType(b)).toBe(null);
  });

  it("refuses a truncated header rather than guessing", () => {
    expect(sniffImageType(new Uint8Array([0x89, 0x50]))).toBe(null);
    expect(sniffImageType(new Uint8Array(0))).toBe(null);
  });
});
