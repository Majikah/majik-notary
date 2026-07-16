import { describe, it, expect } from "vitest";
import { buildMemo, extractSealHash } from "../src/core/memo";
import { MAJIK_NOTARY_MEMO_DOMAIN, SEAL_HASH_HEX_LEN } from "@majikah/majik-signature";

describe("memo", () => {
  const sealHash = "A".repeat(SEAL_HASH_HEX_LEN); 

  it("builds the expected memo format", () => {
    expect(buildMemo(sealHash)).toBe(`${MAJIK_NOTARY_MEMO_DOMAIN}${sealHash}`);
  });

  it("round-trips through extractSealHash", () => {
    const memo = buildMemo(sealHash);
    expect(extractSealHash(memo)).toBe(sealHash);
  });

  it("returns null for a memo with the wrong prefix", () => {
    expect(extractSealHash("some-other-memo:abc123")).toBeNull();
  });

  it("returns null for an unrelated string", () => {
    expect(extractSealHash(sealHash)).toBeNull();
  });
});
