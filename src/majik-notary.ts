/**
 * majik-notary.ts
 *
 * MajikNotary — Solana chain-anchoring for sealed Majikah documents.
 *
 * Composes @majikah/majik-signature's public API only — never reaches into
 * MultiSigEnvelope internals directly. This package owns everything that
 * knows Solana exists; @majikah/majik-signature stays chain-agnostic.
 *
 * IMPORTANT — two ways this gets used, matching the master plan's split:
 *
 *   1. Cloudflare Worker (production): the two-endpoint async flow.
 *      POST /notary/register calls buildRegisterTransaction() + submitTransaction()
 *      directly and returns a "pending" record immediately — it does NOT call
 *      notarize() below. GET /notary/status/:id calls pollConfirmation()
 *      separately, then MajikSignature.registerChainAnchor() once confirmed.
 *      Import the granular functions from "./solana" for that route layer.
 *
 *   2. MajikNotary.notarize() (this file): a synchronous convenience wrapper
 *      that blocks until confirmed via an internal polling loop, for devnet
 *      testing, CLI tooling, or scripts — NOT what the Worker route uses.
 */

import { MajikSignature } from "@majikah/majik-signature";
import type {
  MajikChainAnchor,
  MajikChainAnchorMemo,
} from "@majikah/majik-signature";
import type { KeyPairSigner, Rpc, SolanaRpcApi } from "@solana/kit";

import { buildMemo } from "./core/memo";
import { NOTARY_CHAIN, type NotaryNetwork } from "./core/constants";
import {
  buildRegisterTransaction,
  submitTransaction,
  pollConfirmation,
  fetchOnChainMemo,
  toKitSignature,
} from "./core/solana";

/**
 * Public API for Majik Notary.
 *
 * Majik Notary extends @majikah/majik-signature with Solana-based chain
 * anchoring while keeping blockchain concerns isolated from the core signing
 * library.
 *
 * This module provides:
 * - Memo generation for chain anchors.
 * - End-to-end notarization.
 * - Independent on-chain verification.
 *
 * Lower-level transaction utilities are exposed from "./core/solana" for
 * applications that need custom submission or confirmation workflows.
 */
export class MajikNotary {
  /**
   * Builds the canonical memo payload for a seal hash.
   *
   * This is re-exported for convenience so applications only need to depend on
   * majik-notary when working with chain anchors.
   */
  static buildMemo(sealHashHex: string): MajikChainAnchorMemo {
    return buildMemo(sealHashHex);
  }

  /**
   * Verifies that a chain anchor matches its corresponding on-chain transaction.
   *
   * Verification succeeds only if:
   * - the anchor has reached a confirmed or finalized state,
   * - the referenced transaction exists,
   * - the on-chain memo matches the expected seal hash, and
   * - the transaction remains confirmed on the network.
   *
   * This performs live RPC requests and therefore requires network access.
   */
  static async verifyOnChain(
    anchor: MajikChainAnchor,
    rpc: Rpc<SolanaRpcApi>,
  ): Promise<{ valid: boolean; reason?: string }> {
    if (anchor.status !== "confirmed" && anchor.status !== "finalized") {
      return {
        valid: false,
        reason: `Anchor status is '${anchor.status}', not confirmed`,
      };
    }

    const expectedMemo = buildMemo(anchor.payload.digest.value);

    const onChainMemo = await fetchOnChainMemo(
      toKitSignature(anchor.txSignature),
      rpc,
    );
    if (onChainMemo === null) {
      return { valid: false, reason: "Transaction not found on-chain" };
    }
    if (onChainMemo !== expectedMemo) {
      return {
        valid: false,
        reason: "On-chain memo does not match the claimed seal hash",
      };
    }

    const confirmation = await pollConfirmation(
      toKitSignature(anchor.txSignature),
      rpc,
    );
    if (confirmation.status === "pending" || confirmation.status === "failed") {
      return {
        valid: false,
        reason: `Transaction status is currently '${confirmation.status}'`,
      };
    }

    return { valid: true };
  }

  /**
   * Performs the complete notarization workflow.
   *
   * The file must already contain a valid Majik Signature seal. A memo
   * transaction is created, submitted to Solana, and polled until it reaches a
   * confirmed or finalized state. The resulting chain anchor is then embedded
   * back into the sealed document.
   *
   * This is a synchronous convenience API intended for scripts, CLI tools, and
   * development workflows. Applications that require asynchronous processing
   * should use the lower-level transaction helpers from "./core/solana".
   */
  static async notarize(
    file: Blob,
    feePayerSigner: KeyPairSigner,
    rpc: Rpc<SolanaRpcApi>,
    options?: {
      network?: NotaryNetwork;
      pollIntervalMs?: number;
      timeoutMs?: number;
    },
  ): Promise<{ blob: Blob; anchor: MajikChainAnchor }> {
    const network = options?.network ?? "devnet";
    const pollIntervalMs = options?.pollIntervalMs ?? 1000;
    const timeoutMs = options?.timeoutMs ?? 30_000;

    const { permitted, reason } = await MajikSignature.canAnchor(file);
    if (!permitted)
      throw new Error(
        reason ?? "File is not eligible for anchoring — must be sealed first",
      );

    const sealInfo = await MajikSignature.getSealInfo(file);
    if (!sealInfo)
      throw new Error(
        "Invariant violated: canAnchor() returned true but no seal information was found.",
      );

    /** The memo deterministically represents the seal hash that will be anchored. */
    const memo = buildMemo(sealInfo.sealHash);
    const built = await buildRegisterTransaction(memo, feePayerSigner, rpc);
    const txSignature = await submitTransaction(built, rpc);

    const startedAt = Date.now();
    let confirmation = await pollConfirmation(txSignature, rpc);
    while (confirmation.status === "pending") {
      if (Date.now() - startedAt > timeoutMs) {
        throw new Error(
          `Anchor transaction ${txSignature} did not confirm within ${timeoutMs}ms`,
        );
      }
      await new Promise((r) => setTimeout(r, pollIntervalMs));
      confirmation = await pollConfirmation(txSignature, rpc);
    }

    if (confirmation.status === "failed") {
      throw new Error(`Anchor transaction ${txSignature} failed`);
    }

    // Construct the immutable chain anchor that will be embedded into the file.
    const anchor: MajikChainAnchor = {
      version: 1,
      id: crypto.randomUUID(),
      payload: {
        chain: NOTARY_CHAIN,
        network,
        digest: { algorithm: "SHA3-512", value: sealInfo.sealHash },
      },
      memo,
      txSignature,
      slot: confirmation.slot ?? null,
      blockTime: null,
      confirmedAt: new Date().toISOString(),
      status: confirmation.status,
    };

    const blob = await MajikSignature.registerChainAnchor(file, anchor);
    return { blob, anchor };
  }
}

// Prevent runtime modification of the public API.
Object.freeze(MajikNotary);
Object.freeze(MajikNotary.prototype);
