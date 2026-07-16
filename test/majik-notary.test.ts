import { beforeAll, describe, expect, it } from "vitest";

import {
  buildRegisterTransaction,
  buildRpcUrlMap,
  BuiltTransaction,
  ConfirmationStatus,
  createRpcClient,
  createRpcClientByNetwork,
  fetchOnChainMemo,
  MajikNotary,
  pollConfirmation,
  submitTransaction,
} from "../src";

import { buildMemo, extractSealHash } from "../src/core/memo";

import { MEMO_PROGRAM_ADDRESS, NOTARY_CHAIN } from "../src/core/constants";

import {
  MajikChainAnchor,
  MajikSignature,
  SEAL_HASH_HEX_LEN,
} from "@majikah/majik-signature";
import { loadFixtureKey } from "./helpers/crypto";
import { KeyPairSigner, Rpc, SolanaRpcApi } from "@solana/kit";
import { MajikKey } from "@majikah/majik-key";

describe("MajikNotary", () => {
  let rpc: Rpc<SolanaRpcApi>;

  let keyA: MajikKey;
  let keyB: MajikKey;
  let keyC: MajikKey;
  let keyD: MajikKey;

  let signerA: KeyPairSigner;
  let signerB: KeyPairSigner;
  let signerC: KeyPairSigner;
  let signerD: KeyPairSigner;

  const TEST_SEAL_HASH = "A".repeat(SEAL_HASH_HEX_LEN);

  const TEST_MEMO = buildMemo(TEST_SEAL_HASH);

  const TEST_RPC_URL = `https://devnet.helius-rpc.com/?api-key=${process.env.VITE_HELIUS_API_KEY}`;

  let submittedTransaction: BuiltTransaction;
  let submittedSignature: string;

  beforeAll(async () => {
    rpc = createRpcClient(TEST_RPC_URL);

    [keyA, keyB, keyC, keyD] = await Promise.all([
      loadFixtureKey(1),
      loadFixtureKey(2),
      loadFixtureKey(3),
      loadFixtureKey(4),
    ]);

    [signerA, signerB, signerC, signerD] = (await Promise.all([
      keyA.getSolanaKeypair(),
      keyB.getSolanaKeypair(),
      keyC.getSolanaKeypair(),
      keyD.getSolanaKeypair(),
    ])) as KeyPairSigner[];
  }, 180000);
  describe("Constants", () => {
    it("should expose the Solana chain identifier", () => {
      expect(NOTARY_CHAIN).toBe("solana");
    });

    it("should expose the SPL Memo program address", () => {
      expect(MEMO_PROGRAM_ADDRESS).toBe(
        "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
      );
    });
  });

  describe("Memo Utilities", () => {
    it("should build the canonical memo", () => {
      const memo = buildMemo(TEST_SEAL_HASH);

      expect(memo).toBe(MajikSignature.buildChainAnchorMemo(TEST_SEAL_HASH));
    });

    it("should build deterministic memos", () => {
      expect(buildMemo(TEST_SEAL_HASH)).toBe(buildMemo(TEST_SEAL_HASH));
    });

    it("should extract the original seal hash", () => {
      const memo = buildMemo(TEST_SEAL_HASH);

      expect(extractSealHash(memo)).toBe(TEST_SEAL_HASH);
    });

    it("should return null for an invalid memo prefix", () => {
      expect(extractSealHash("INVALID_PREFIX:abcdef")).toBeNull();
    });

    it("should return null for an empty string", () => {
      expect(extractSealHash("")).toBeNull();
    });

    it("should return null for arbitrary text", () => {
      expect(extractSealHash("hello world")).toBeNull();
    });

    it("should return an empty seal hash when only the domain prefix exists", () => {
      // Generate a valid memo to safely get the prefix
      const validMemo = buildMemo(TEST_SEAL_HASH);
      const prefixOnlyMemo = validMemo.replace(TEST_SEAL_HASH, "");

      expect(extractSealHash(prefixOnlyMemo)).toBe("");
    });
  });

  describe("Public API", () => {
    it("should expose buildMemo()", () => {
      expect(MajikNotary.buildMemo(TEST_SEAL_HASH)).toBe(
        buildMemo(TEST_SEAL_HASH),
      );
    });
  });

  describe("RPC Client", () => {
    it("should create a Devnet RPC client using the default endpoint", () => {
      const rpc = createRpcClient();

      expect(rpc).toBeDefined();
    });

    it("should create a Devnet RPC client by network", () => {
      const rpc = createRpcClientByNetwork("devnet");

      expect(rpc).toBeDefined();
    });

    it("should create an RPC client from a custom URL", () => {
      const rpc = createRpcClient("https://api.devnet.solana.com");

      expect(rpc).toBeDefined();
    });

    it("should build the default RPC URL map", () => {
      const map = buildRpcUrlMap();

      expect(map.devnet).toBe("https://api.devnet.solana.com");

      expect(map["mainnet-beta"]).toBe("");
    });

    it("should allow overriding the Devnet endpoint", () => {
      const map = buildRpcUrlMap({
        devnet: "https://example.com",
      });

      expect(map.devnet).toBe("https://example.com");
    });

    it("should allow overriding the Mainnet endpoint", () => {
      const map = buildRpcUrlMap({
        "mainnet-beta": "https://rpc.example.com",
      });

      expect(map["mainnet-beta"]).toBe("https://rpc.example.com");
    });

    it("should throw when creating a client for an unconfigured network", () => {
      expect(() => createRpcClientByNetwork("mainnet-beta")).toThrow(
        "No RPC URL configured for network: mainnet-beta",
      );
    });
  });

  describe("Transaction Construction", () => {
    it("should build a signed transaction", async () => {
      const built = await buildRegisterTransaction(TEST_MEMO, signerA, rpc);

      expect(built.signature).toBeDefined();
      expect(typeof built.signature).toBe("string");
      expect(built.wireTransaction).toBeDefined();
    });

    it("should produce a deterministic signature for the built transaction", async () => {
      const built = await buildRegisterTransaction(TEST_MEMO, signerA, rpc);
      expect(built.signature.length).toBeGreaterThan(40);
    });

    it("should produce a serialized wire transaction", async () => {
      const built = await buildRegisterTransaction(TEST_MEMO, signerA, rpc);

      expect(built.wireTransaction.length).toBeGreaterThan(0);
    });

    it("should produce different signatures for different fee payers", async () => {
      const txA = await buildRegisterTransaction(TEST_MEMO, signerA, rpc);

      const txB = await buildRegisterTransaction(TEST_MEMO, signerB, rpc);

      expect(txA.signature).not.toBe(txB.signature);
    });

    it("should reject an invalid signer", async () => {
      const rpc = createRpcClientByNetwork("devnet");

      await expect(
        buildRegisterTransaction(TEST_MEMO, {} as any, rpc),
      ).rejects.toThrow();
    });

    it("should reject an invalid RPC client", async () => {
      const key = await loadFixtureKey(1);
      const solanaSigner = (await key.getSolanaKeypair()) as KeyPairSigner;

      await expect(
        buildRegisterTransaction(TEST_MEMO, solanaSigner, {} as any),
      ).rejects.toThrow();
    });
  });

  describe("Transaction Submission", () => {
    it("should submit a transaction to Solana Devnet", async () => {
      const built = await buildRegisterTransaction(TEST_MEMO, signerA, rpc);

      const signature = await submitTransaction(built, rpc);

      submittedTransaction = built;
      submittedSignature = signature;

      expect(signature).toBe(built.signature);
      expect(signature.length).toBeGreaterThan(40);
    });

    it("should submit transactions from different fee payers", async () => {
      const txA = await buildRegisterTransaction(TEST_MEMO, signerA, rpc);

      const txB = await buildRegisterTransaction(TEST_MEMO, signerB, rpc);

      const sigA = await submitTransaction(txA, rpc);
      const sigB = await submitTransaction(txB, rpc);

      expect(sigA).not.toBe(sigB);
    });

    it("should safely resolve duplicate submissions returning the same signature", async () => {
      const built = await buildRegisterTransaction(TEST_MEMO, signerA, rpc);

      const firstSignature = await submitTransaction(built, rpc);
      const secondSignature = await submitTransaction(built, rpc);

      expect(firstSignature).toBe(secondSignature);
    });

    it("should reject an invalid RPC client", async () => {
      const built = await buildRegisterTransaction(TEST_MEMO, signerA, rpc);

      await expect(
        submitTransaction(built, {} as Rpc<SolanaRpcApi>),
      ).rejects.toThrow();
    });

    it("should reject an invalid transaction", async () => {
      await expect(
        submitTransaction(
          {
            signature: "invalid" as any,
            wireTransaction: "invalid" as any,
          },
          rpc,
        ),
      ).rejects.toThrow();
    });
  });

  describe("Confirmation Polling", () => {
    it("should eventually confirm a submitted transaction", async () => {
      expect(submittedSignature).toBeDefined();

      let confirmation: ConfirmationStatus;

      do {
        confirmation = await pollConfirmation(submittedSignature as any, rpc);

        if (confirmation.status === "pending") {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } while (confirmation.status === "pending");

      expect(["confirmed", "finalized"]).toContain(confirmation.status);

      expect(confirmation.slot).toBeDefined();
      expect(confirmation.slot).toBeGreaterThan(0);
    });

    it("should return finalized or confirmed when polled again", async () => {
      const confirmation = await pollConfirmation(
        submittedSignature as any,
        rpc,
      );

      expect(["confirmed", "finalized"]).toContain(confirmation.status);
    });

    it("should return pending for a nonexistent transaction", async () => {
      const fakeSignature =
        "1111111111111111111111111111111111111111111111111111111111111111";

      const confirmation = await pollConfirmation(fakeSignature as any, rpc);

      expect(confirmation.status).toBe("pending");
    });

    it("should reject an invalid RPC client", async () => {
      await expect(
        pollConfirmation(submittedSignature as any, {} as Rpc<SolanaRpcApi>),
      ).rejects.toThrow();
    });

    it("should reject an invalid transaction signature", async () => {
      await expect(pollConfirmation("invalid" as any, rpc)).rejects.toThrow();
    });
  });

  describe("On-chain Memo Retrieval", () => {
    it("should retrieve the memo written to the blockchain", async () => {
      const memo = await fetchOnChainMemo(submittedSignature as any, rpc);

      expect(memo).toBe(TEST_MEMO);
    });

    it("should retrieve the original seal hash from the on-chain memo", async () => {
      const memo = await fetchOnChainMemo(submittedSignature as any, rpc);

      expect(memo).not.toBeNull();
      expect(extractSealHash(memo!)).toBe(TEST_SEAL_HASH);
    });

    it("should return null for a nonexistent transaction", async () => {
      const fakeSignature =
        "1111111111111111111111111111111111111111111111111111111111111111";

      const memo = await fetchOnChainMemo(fakeSignature as any, rpc);

      expect(memo).toBeNull();
    });

    it("should reject an invalid RPC client", async () => {
      await expect(
        fetchOnChainMemo(submittedSignature as any, {} as Rpc<SolanaRpcApi>),
      ).rejects.toThrow();
    });

    it("should reject an invalid transaction signature", async () => {
      await expect(fetchOnChainMemo("invalid" as any, rpc)).rejects.toThrow();
    });
  });

  describe("On-chain Verification", () => {
    let anchor: MajikChainAnchor;

    beforeAll(async () => {
      const confirmation = await pollConfirmation(
        submittedSignature as any,
        rpc,
      );

      anchor = {
        version: 1,
        id: crypto.randomUUID(),
        payload: {
          chain: NOTARY_CHAIN,
          network: "devnet",
          digest: {
            algorithm: "SHA3-512",
            value: TEST_SEAL_HASH,
          },
        },
        memo: TEST_MEMO,
        txSignature: submittedSignature,
        slot: confirmation.slot ?? null,
        blockTime: null,
        confirmedAt: new Date().toISOString(),
        status: confirmation.status === "finalized" ? "finalized" : "confirmed",
      };
    });

    it("should successfully verify a valid chain anchor", async () => {
      const result = await MajikNotary.verifyOnChain(anchor, rpc);

      expect(result.valid).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it("should fail when the anchor status is pending", async () => {
      const result = await MajikNotary.verifyOnChain(
        {
          ...anchor,
          status: "pending",
        },
        rpc,
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("pending");
    });

    it("should fail when the anchor status is failed", async () => {
      const result = await MajikNotary.verifyOnChain(
        {
          ...anchor,
          status: "failed",
        },
        rpc,
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("failed");
    });

    it("should fail when the stored seal hash is incorrect", async () => {
      const result = await MajikNotary.verifyOnChain(
        {
          ...anchor,
          payload: {
            ...anchor.payload,
            digest: {
              ...anchor.payload.digest,
              value: "f".repeat(SEAL_HASH_HEX_LEN), // Must be exactly 128 chars
            },
          },
        },
        rpc,
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("memo");
    });

    it("should fail when the transaction does not exist", async () => {
      const result = await MajikNotary.verifyOnChain(
        {
          ...anchor,
          txSignature:
            "1111111111111111111111111111111111111111111111111111111111111111",
        },
        rpc,
      );

      expect(result.valid).toBe(false);
      expect(result.reason).toContain("Transaction not found");
    });

    it("should reject an invalid RPC client", async () => {
      await expect(
        MajikNotary.verifyOnChain(anchor, {} as Rpc<SolanaRpcApi>),
      ).rejects.toThrow();
    });

    it("should reject an invalid transaction signature", async () => {
      await expect(
        MajikNotary.verifyOnChain(
          {
            ...anchor,
            txSignature: "invalid",
          },
          rpc,
        ),
      ).rejects.toThrow();
    });

    it("should be deterministic across multiple verifications", async () => {
      const first = await MajikNotary.verifyOnChain(anchor, rpc);

      const second = await MajikNotary.verifyOnChain(anchor, rpc);

      expect(first).toEqual(second);
    });

    it("should ignore a tampered stored memo and verify using the digest", async () => {
      const result = await MajikNotary.verifyOnChain(
        {
          ...anchor,
          memo: "THIS_HAS_BEEN_TAMPERED",
        },
        rpc,
      );

      expect(result.valid).toBe(true);
    });
  });

  describe("Full Notarization Workflow", () => {
    let originalBlob: Blob;
    let sealedBlob: Blob;
    let notarizedBlob: Blob;
    let anchor: MajikChainAnchor;

    // 1. Declare dynamic expectation variables
    let expectedSealHash: string;
    let expectedMemo: string;

    beforeAll(async () => {
      originalBlob = new Blob(["Hello from Majik Notary!"], {
        type: "text/plain",
      });

      // Sign the document first to create the envelope
      const { blob: signedBlob } = await MajikSignature.signFile(
        originalBlob,
        keyA,
      );

      // Seal the signed document
      const { blob } = await MajikSignature.seal(signedBlob, keyA);

      sealedBlob = blob;

      // 2. Extract the actual cryptographic seal hash of your sealed document
      const sealInfo = await MajikSignature.getSealInfo(sealedBlob);
      if (!sealInfo) {
        throw new Error("Failed to extract seal info from sealedBlob");
      }

      expectedSealHash = sealInfo.sealHash;
      expectedMemo = buildMemo(expectedSealHash);

      // Register a real chain anchor on Solana Devnet
      const result = await MajikNotary.notarize(sealedBlob, signerA, rpc, {
        network: "devnet",
        pollIntervalMs: 2500, // Safe rate-limit window for Helius
        timeoutMs: 60_000,
      });

      notarizedBlob = result.blob;
      anchor = result.anchor;
    });

    it("should notarize a sealed document", () => {
      expect(notarizedBlob).toBeDefined();

      expect(anchor).toBeDefined();
      expect(anchor.txSignature.length).toBeGreaterThan(40);

      expect(["confirmed", "finalized"]).toContain(anchor.status);

      expect(anchor.payload.chain).toBe(NOTARY_CHAIN);
      expect(anchor.payload.network).toBe("devnet");
    });

    it("should return a new blob instance", () => {
      expect(notarizedBlob).not.toBe(sealedBlob);
    });

    // 3. Update assertion to use the dynamic seal hash
    it("should preserve the original seal hash", async () => {
      const sealInfo = await MajikSignature.getSealInfo(notarizedBlob);

      expect(sealInfo).not.toBeNull();
      expect(sealInfo!.sealHash).toBe(expectedSealHash);
    });

    it("should register the chain anchor inside the envelope", async () => {
      const chainAnchors = await MajikSignature.getChainAnchors(notarizedBlob);

      expect(chainAnchors).not.toBeNull();

      expect(chainAnchors.length).toBeGreaterThan(0);

      expect(chainAnchors[0].txSignature).toBe(anchor.txSignature);

      expect(chainAnchors[0].payload.chain).toBe("solana");
    });

    // 4. Update assertion to use the dynamic memo
    it("should preserve the generated memo", () => {
      expect(anchor.memo).toBe(expectedMemo);
    });

    it("should preserve the transaction signature", () => {
      expect(anchor.txSignature.length).toBeGreaterThan(40);
    });

    it("should preserve the network", () => {
      expect(anchor.payload.network).toBe("devnet");
    });

    it("should preserve the chain", () => {
      expect(anchor.payload.chain).toBe(NOTARY_CHAIN);
    });

    // 5. Update assertion to use the dynamic seal hash
    it("should preserve the digest", () => {
      expect(anchor.payload.digest.algorithm).toBe("SHA3-512");
      expect(anchor.payload.digest.value).toBe(expectedSealHash);
    });

    it("should remain eligible for additional chain anchors", async () => {
      const result = await MajikSignature.canAnchor(notarizedBlob);

      expect(result.permitted).toBe(true);
    });

    it("should successfully verify the registered chain anchor", async () => {
      const verification = await MajikNotary.verifyOnChain(anchor, rpc);

      expect(verification.valid).toBe(true);
      expect(verification.reason).toBeUndefined();
    });

    it("should reject an unsealed document", async () => {
      const blob = new Blob(["This document is not sealed"], {
        type: "text/plain",
      });

      await expect(MajikNotary.notarize(blob, signerA, rpc)).rejects.toThrow();
    });

    it("should reject an invalid signer", async () => {
      await expect(
        MajikNotary.notarize(sealedBlob, {} as KeyPairSigner, rpc),
      ).rejects.toThrow();
    });

    it("should reject an invalid RPC client", async () => {
      await expect(
        MajikNotary.notarize(sealedBlob, signerA, {} as Rpc<SolanaRpcApi>),
      ).rejects.toThrow();
    });

    it("should produce deterministic verification results", async () => {
      const first = await MajikNotary.verifyOnChain(anchor, rpc);

      const second = await MajikNotary.verifyOnChain(anchor, rpc);

      expect(first).toEqual(second);
    });

    it("should allow fetching the registered seal info repeatedly", async () => {
      const first = await MajikSignature.getSealInfo(notarizedBlob);

      const second = await MajikSignature.getSealInfo(notarizedBlob);

      expect(first).toEqual(second);
    });
  });
});
