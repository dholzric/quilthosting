import { describe, it, expect } from "vitest";
import { allowedOrigin } from "./corsPolicy";

const APP = "https://quilthosting.com";

describe("allowedOrigin", () => {
  it("allows the platform origin and its subdomains", () => {
    expect(allowedOrigin("https://quilthosting.com", APP, "production")).toBe(
      "https://quilthosting.com"
    );
    expect(allowedOrigin("https://prairie-star.quilthosting.com", APP, "production")).toBe(
      "https://prairie-star.quilthosting.com"
    );
  });

  it("rejects look-alike hosts and unrelated origins", () => {
    expect(allowedOrigin("https://quilthosting.com.evil.example", APP, "production")).toBeNull();
    expect(allowedOrigin("https://notquilthosting.com", APP, "production")).toBeNull();
    expect(allowedOrigin("https://evil.example", APP, "production")).toBeNull();
    expect(allowedOrigin("null", APP, "production")).toBeNull();
    expect(allowedOrigin("garbage", APP, "production")).toBeNull();
  });

  it("allows native app shells regardless of environment", () => {
    expect(allowedOrigin("capacitor://localhost", APP, "production")).toBe("capacitor://localhost");
    expect(allowedOrigin("ionic://localhost", APP, "production")).toBe("ionic://localhost");
  });

  it("allows localhost only in development", () => {
    expect(allowedOrigin("http://localhost:8787", APP, "development")).toBe("http://localhost:8787");
    expect(allowedOrigin("http://127.0.0.1:3000", APP, "development")).toBe("http://127.0.0.1:3000");
    expect(allowedOrigin("http://localhost:8787", APP, "production")).toBeNull();
  });

  it("emits nothing when there is no Origin header or no APP_URL", () => {
    expect(allowedOrigin(undefined, APP, "production")).toBeNull();
    expect(allowedOrigin("https://quilthosting.com", undefined, "production")).toBeNull();
  });
});
