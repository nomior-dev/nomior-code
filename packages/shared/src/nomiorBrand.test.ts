import { describe, expect, it } from "vite-plus/test";
import { NOMIOR_PRODUCT_NAME, containsUpstreamBranding } from "./nomiorBrand.ts";

describe("nomiorBrand", () => {
  it("names the product Nomior Code", () => {
    expect(NOMIOR_PRODUCT_NAME).toBe("Nomior Code");
  });

  it("carries no upstream T3 marks", () => {
    expect(containsUpstreamBranding(NOMIOR_PRODUCT_NAME)).toBe(false);
  });

  it("detects upstream branding in display strings", () => {
    expect(containsUpstreamBranding("T3 Code")).toBe(true);
    expect(containsUpstreamBranding("T3 Code (Nightly)")).toBe(true);
    expect(containsUpstreamBranding("t3 code splash screen")).toBe(true);
    expect(containsUpstreamBranding("Nomior Code (Alpha)")).toBe(false);
    // Reverse-DNS and slug identifiers must not trip the detector even when
    // they embed an upstream token inside a larger technical string.
    expect(containsUpstreamBranding("com.t3tools.t3code")).toBe(false);
  });
});
