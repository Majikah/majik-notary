/**
 * constants.ts
 *
 * Shared constants used throughout majik-notary.
 *
 * This module defines Solana-specific values that are referenced across the
 * library, including supported networks, chain identifiers, and program
 * addresses.
 */

/**
 * Chain identifier stored in Majik chain anchors.
 */
export const NOTARY_CHAIN = "solana" as const;

/**
 * Supported Solana networks for chain anchoring.
 */
export type NotaryNetwork = "mainnet-beta" | "devnet";

/**
 * SPL Memo Program address.
 *
 * All Majik Notary chain anchors are recorded using the Solana Memo Program.
 */
export const MEMO_PROGRAM_ADDRESS =
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as const;
