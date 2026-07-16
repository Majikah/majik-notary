/**
 * memo.ts
 * Memo utilities for Solana chain anchors.
 *
 * The memo format is defined by @majikah/majik-signature. This module simply
 * re-exports the functionality needed by majik-notary so both packages share
 * a single canonical memo format.
 */

import {
  MAJIK_NOTARY_MEMO_DOMAIN,
  MajikSignature,
} from "@majikah/majik-signature";
import type { MajikChainAnchorMemo } from "@majikah/majik-signature";

/**
 * Builds the canonical memo payload for a sealed document's hash.
 *
 * The resulting string is intended to be written to the Solana Memo Program
 * and uniquely represents the sealed document being anchored.
 */
export function buildMemo(sealHashHex: string): MajikChainAnchorMemo {
  return MajikSignature.buildChainAnchorMemo(sealHashHex);
}

/**
 * Extracts the seal hash from a chain-anchor memo.
 *
 * Returns the embedded seal hash if the memo uses the expected Majik Notary
 * domain prefix; otherwise returns null.
 */
export function extractSealHash(memo: string): string | null {
  if (!memo.startsWith(MAJIK_NOTARY_MEMO_DOMAIN)) return null;
  return memo.slice(MAJIK_NOTARY_MEMO_DOMAIN.length);
}
