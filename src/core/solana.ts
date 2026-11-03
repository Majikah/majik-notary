/**
 * Solana RPC integration utilities.
 *
 * This module is the only layer within majik-notary that communicates directly
 * with the Solana network through @solana/kit.
 *
 * Responsibilities:
 * - Create RPC clients for supported networks.
 * - Build private or externally co-signed memo transactions.
 * - Verify and attach externally collected transaction signatures.
 * - Complete transactions with the Majikah fee payer.
 * - Submit transactions to the network.
 * - Poll transaction confirmation status.
 * - Read memo data back from confirmed transactions.
 *
 * Co-signing is deliberately separate from off-chain message signing. An
 * additional signer is made a required signer of the actual Solana transaction
 * message, and its Ed25519 signature is verified over those exact message
 * bytes before the fee payer signs.
 */

import {
  address,
  AccountRole,
  createSolanaRpc,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  partiallySignTransactionWithSigners,
  assertIsFullySignedTransaction,
  compileTransaction,
  getTransactionDecoder,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getBase64Decoder,
  getPublicKeyFromAddress,
  verifySignature,
  getBase58Encoder,
  signature as brandSignature,
  pipe,
  type Address,
  type Rpc,
  type SolanaRpcApi,
  type KeyPairSigner,
  type Instruction,
  type Signature,
  type SignatureBytes,
  type Base64EncodedWireTransaction,
} from "@solana/kit";

import { MEMO_PROGRAM_ADDRESS, type NotaryNetwork } from "./constants.js";
import { MajikChainAnchorTxSignature } from "@majikah/majik-signature";

export const DEFAULT_DEVNET_RPC_URL = "https://api.devnet.solana.com" as const;

/**
 * Converts a Majik Signature transaction signature into @solana/kit's branded
 * Signature type.
 *
 * This centralizes the conversion between the public library types and the
 * underlying Solana SDK, avoiding direct dependency on kit's branding helpers
 * throughout the codebase.
 */
export function toKitSignature(
  txSignature: MajikChainAnchorTxSignature,
): Signature {
  return brandSignature(txSignature);
}

/**
 * Immutable mapping between supported notary networks and their RPC endpoints.
 */
export type RpcUrlMap = Readonly<Record<NotaryNetwork, string>>;

/**
 * Default RPC endpoints used by majik-notary.
 *
 * Mainnet is intentionally left unset so production deployments must explicitly
 * configure their preferred RPC provider.
 */
export const DEFAULT_RPC_URLS: RpcUrlMap = Object.freeze({
  devnet: "https://api.devnet.solana.com",
  "mainnet-beta": "",
});

/**
 * Builds an immutable RPC URL configuration by merging custom endpoints with
 * the library defaults.
 */
export function buildRpcUrlMap(urls: Partial<RpcUrlMap> = {}): RpcUrlMap {
  return Object.freeze({
    ...DEFAULT_RPC_URLS,
    ...urls,
  });
}

/**
 * Creates a Solana RPC client for the given network.
 *
 * Throws if no endpoint is configured for the requested network.
 */
export function createRpcClientByNetwork(
  network: NotaryNetwork,
  rpcUrls: RpcUrlMap = DEFAULT_RPC_URLS,
): Rpc<SolanaRpcApi> {
  const url = rpcUrls[network];

  if (!url) {
    throw new Error("No RPC URL configured for network: " + network);
  }

  return createSolanaRpc(url);
}

/**
 * Creates a Solana RPC client for a specific endpoint.
 *
 * Defaults to the public Solana Devnet RPC.
 */
export function createRpcClient(
  rpcUrl: string = DEFAULT_DEVNET_RPC_URL,
): Rpc<SolanaRpcApi> {
  return createSolanaRpc(rpcUrl);
}

/**
 * Creates a SPL Memo instruction compatible with @solana/kit.
 *
 * The fee payer and every additional address are declared as read-only
 * signers. The Memo Program checks the supplied signer accounts, making each
 * one a required signer of the transaction without granting write access.
 */
function buildMemoInstruction(
  memo: string,
  feePayerAddress: Address,
  additionalRequiredSigners: readonly Address[] = [],
): Instruction {
  return {
    programAddress: address(MEMO_PROGRAM_ADDRESS),
    accounts: [
      {
        address: feePayerAddress,
        role: AccountRole.READONLY_SIGNER,
      },
      ...additionalRequiredSigners.map((signerAddress) => ({
        address: signerAddress,
        role: AccountRole.READONLY_SIGNER,
      })),
    ],
    data: new TextEncoder().encode(memo),
  };
}

export interface BuiltTransaction {
  /** Serialized, fully signed transaction ready for sendTransaction(). */
  wireTransaction: Base64EncodedWireTransaction;

  /** Transaction signature computed during signing. */
  signature: Signature;
}

/**
 * Options for building a transaction that requires one or more external
 * signers in addition to the Majikah fee payer.
 *
 * Supplying this option always returns an unsigned draft. The fee payer is
 * deliberately not asked to sign until all external signatures are collected.
 */
export interface BuildRegisterTransactionOptions {
  /** Additional required transaction signers, excluding the fee payer. */
  additionalRequiredSigners: readonly Address[];
}

/**
 * Unsigned transaction draft prepared for external co-signing.
 *
 * unsignedWireTransaction contains the compiled transaction with empty
 * signature slots. messageBytes is the exact compiled message that external
 * signers must sign, Base64-encoded for transport.
 */
export interface RegisterTransactionDraft {
  readonly version: 1;
  readonly unsignedWireTransaction: Base64EncodedWireTransaction;
  readonly messageBytes: string;
  readonly feePayerAddress: Address;
  readonly additionalRequiredSigners: readonly Address[];
  readonly blockhash: string;
  readonly lastValidBlockHeight: string;
}

/**
 * An Ed25519 signature collected from an external transaction signer.
 * The signature must cover the exact messageBytes in the draft.
 */
export interface ExternalTransactionSignature {
  readonly address: Address;
  readonly signature: Uint8Array;
}

/**
 * Builds and signs a private memo transaction.
 *
 * This overload preserves the original behavior: the Majikah fee payer is the
 * only required signer and signs immediately.
 */
export function buildRegisterTransaction(
  memo: string,
  feePayerSigner: KeyPairSigner,
  rpc: Rpc<SolanaRpcApi>,
): Promise<BuiltTransaction>;

/**
 * Builds an unsigned memo transaction draft that requires the supplied
 * additional signers plus the Majikah fee payer.
 *
 * The fee payer signature is deferred until completeRegisterTransaction().
 */
export function buildRegisterTransaction(
  memo: string,
  feePayerSigner: KeyPairSigner,
  rpc: Rpc<SolanaRpcApi>,
  options: BuildRegisterTransactionOptions,
): Promise<RegisterTransactionDraft>;

/**
 * Builds the memo transaction used to register a chain anchor.
 *
 * Without options, this retains the existing private one-signer flow.
 * With additionalRequiredSigners, it returns an unsigned draft so the
 * additional signers can sign the exact compiled Solana transaction message
 * before the fee payer signs.
 */
export async function buildRegisterTransaction(
  memo: string,
  feePayerSigner: KeyPairSigner,
  rpc: Rpc<SolanaRpcApi>,
  options?: BuildRegisterTransactionOptions,
): Promise<BuiltTransaction | RegisterTransactionDraft> {
  let additionalRequiredSigners: Address[] = [];

  if (options) {
    if (
      !Array.isArray(options.additionalRequiredSigners) ||
      options.additionalRequiredSigners.length === 0
    ) {
      throw new Error(
        "Co-signed transaction drafts require at least one additional signer",
      );
    }

    additionalRequiredSigners = options.additionalRequiredSigners.map(
      (signerAddress) => address(signerAddress),
    );

    if (new Set(additionalRequiredSigners).size !== additionalRequiredSigners.length) {
      throw new Error("Additional transaction signer addresses must be unique");
    }

    if (additionalRequiredSigners.includes(feePayerSigner.address)) {
      throw new Error(
        "The fee payer cannot also be supplied as an additional signer",
      );
    }
  }

  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const instruction = buildMemoInstruction(
    memo,
    feePayerSigner.address,
    additionalRequiredSigners,
  );

  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(feePayerSigner, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions([instruction], tx),
  );

  // Preserve the legacy private behavior exactly when no co-signers are
  // requested. The additional-signer path must not sign with the fee payer yet.
  if (!options) {
    const signedTransaction =
      await signTransactionMessageWithSigners(transactionMessage);
    const signature = getSignatureFromTransaction(signedTransaction);
    const wireTransaction = getBase64EncodedWireTransaction(signedTransaction);

    return { wireTransaction, signature };
  }

  const unsignedTransaction = compileTransaction(transactionMessage);

  return {
    version: 1,
    unsignedWireTransaction: getBase64EncodedWireTransaction(
      unsignedTransaction,
    ),
    messageBytes: getBase64Encoder().encode(unsignedTransaction.messageBytes),
    feePayerAddress: feePayerSigner.address,
    additionalRequiredSigners: Object.freeze([...additionalRequiredSigners]),
    blockhash: latestBlockhash.blockhash,
    lastValidBlockHeight: latestBlockhash.lastValidBlockHeight.toString(),
  };
}

/**
 * Verifies externally collected Ed25519 transaction signatures, attaches them
 * to the unsigned draft, then signs the remaining fee-payer slot last.
 *
 * This function does not fetch or change the blockhash, transaction message,
 * instructions, account metas, or fee payer. The returned BuiltTransaction
 * can be passed directly to submitTransaction().
 */
export async function completeRegisterTransaction(
  draft: RegisterTransactionDraft,
  externalSignatures: readonly ExternalTransactionSignature[],
  feePayerSigner: KeyPairSigner,
): Promise<BuiltTransaction> {
  if (!draft || draft.version !== 1) {
    throw new Error("Unsupported or invalid register transaction draft");
  }

  if (feePayerSigner.address !== draft.feePayerAddress) {
    throw new Error(
      "The supplied fee payer does not match the transaction draft",
    );
  }

  if (!Array.isArray(externalSignatures)) {
    throw new Error("External transaction signatures must be an array");
  }

  const transactionBytes = getBase64Decoder().decode(
    draft.unsignedWireTransaction,
  );
  const decodedTransaction = getTransactionDecoder().decode(transactionBytes);

  const decodedMessageBase64 = getBase64Encoder().encode(
    decodedTransaction.messageBytes,
  );

  if (decodedMessageBase64 !== draft.messageBytes) {
    throw new Error(
      "Transaction message bytes do not match the prepared draft",
    );
  }

  const transactionSignerAddresses = Object.keys(
    decodedTransaction.signatures,
  ) as Address[];

  if (transactionSignerAddresses[0] !== feePayerSigner.address) {
    throw new Error(
      "The transaction fee payer is not the first required signer",
    );
  }

  // A draft must be unsigned. Do not accept a draft containing signatures
  // that were not collected through this completion call.
  for (const signerAddress of transactionSignerAddresses) {
    if (decodedTransaction.signatures[signerAddress] !== null) {
      throw new Error("The supplied transaction draft is not unsigned");
    }
  }

  const expectedAdditionalSigners = transactionSignerAddresses.filter(
    (signerAddress) => signerAddress !== feePayerSigner.address,
  );
  const declaredAdditionalSigners = draft.additionalRequiredSigners.map(
    (signerAddress) => address(signerAddress),
  );

  if (
    declaredAdditionalSigners.length === 0 ||
    new Set(declaredAdditionalSigners).size !== declaredAdditionalSigners.length ||
    expectedAdditionalSigners.length !== declaredAdditionalSigners.length ||
    expectedAdditionalSigners.some(
      (signerAddress) => !declaredAdditionalSigners.includes(signerAddress),
    )
  ) {
    throw new Error(
      "Draft additional signers do not match the compiled transaction",
    );
  }

  if (externalSignatures.length !== expectedAdditionalSigners.length) {
    throw new Error(
      "A signature is required from every additional transaction signer",
    );
  }

  const verifiedSignatures: Record<Address, SignatureBytes> = {};
  const seenSigners = new Set<Address>();

  for (const externalSignature of externalSignatures) {
    const signerAddress = address(externalSignature.address);

    if (!expectedAdditionalSigners.includes(signerAddress)) {
      throw new Error(
        "Unexpected external transaction signer: " + signerAddress,
      );
    }

    if (seenSigners.has(signerAddress)) {
      throw new Error(
        "Duplicate external transaction signature: " + signerAddress,
      );
    }
    seenSigners.add(signerAddress);

    if (
      !(externalSignature.signature instanceof Uint8Array) ||
      externalSignature.signature.length !== 64
    ) {
      throw new Error(
        "Ed25519 transaction signatures must contain exactly 64 bytes",
      );
    }

    const publicKey = await getPublicKeyFromAddress(signerAddress);
    const valid = await verifySignature(
      publicKey,
      externalSignature.signature as SignatureBytes,
      decodedTransaction.messageBytes,
    );

    if (!valid) {
      throw new Error(
        "Invalid transaction signature from external signer: " +
          signerAddress,
      );
    }

    verifiedSignatures[signerAddress] =
      externalSignature.signature as SignatureBytes;
  }

  const transactionWithExternalSignatures = Object.freeze({
    ...decodedTransaction,
    signatures: Object.freeze({
      ...decodedTransaction.signatures,
      ...verifiedSignatures,
    }),
  });

  // The external signatures are already verified and attached. The only
  // signer passed to Kit now is the Majikah fee payer, so it signs last.
  const completedTransaction = await partiallySignTransactionWithSigners(
    [feePayerSigner],
    transactionWithExternalSignatures,
  );

  assertIsFullySignedTransaction(completedTransaction);

  return {
    wireTransaction: getBase64EncodedWireTransaction(completedTransaction),
    signature: getSignatureFromTransaction(completedTransaction),
  };
}

/**
 * Broadcasts a previously built, fully signed transaction.
 *
 * Returns the precomputed transaction signature.
 */
export async function submitTransaction(
  built: BuiltTransaction,
  rpc: Rpc<SolanaRpcApi>,
): Promise<Signature> {
  await rpc
    .sendTransaction(built.wireTransaction, { encoding: "base64" })
    .send();
  return built.signature;
}

/**
 * Current network confirmation state for a transaction.
 */
export interface ConfirmationStatus {
  status: "pending" | "confirmed" | "finalized" | "failed";
  slot?: number;
  blockTime?: number;
}

/**
 * Queries the current confirmation status of a transaction.
 *
 * This performs a single RPC lookup and never blocks waiting for confirmation.
 * Callers are expected to poll this method according to their own retry policy.
 */
export async function pollConfirmation(
  txSignature: Signature,
  rpc: Rpc<SolanaRpcApi>,
): Promise<ConfirmationStatus> {
  const { value } = await rpc.getSignatureStatuses([txSignature]).send();
  const info = value[0];

  if (!info) return { status: "pending" };
  if (info.err) return { status: "failed" };

  if (info.confirmationStatus === "finalized") {
    return { status: "finalized", slot: Number(info.slot) };
  }
  if (info.confirmationStatus === "confirmed") {
    return { status: "confirmed", slot: Number(info.slot) };
  }
  return { status: "pending", slot: info.slot ? Number(info.slot) : undefined };
}

/**
 * Retrieves the UTF-8 memo stored in a confirmed transaction.
 *
 * Returns null if the transaction cannot be found or contains no memo
 * instruction.
 *
 * This function intentionally requests the raw JSON transaction encoding rather
 * than jsonParsed. The memo instruction data is decoded locally instead of
 * relying on RPC-provider-specific instruction parsers, ensuring consistent
 * behavior across different Solana RPC implementations.
 */
export async function fetchOnChainMemo(
  txSignature: Signature,
  rpc: Rpc<SolanaRpcApi>,
): Promise<string | null> {
  const tx = await rpc
    .getTransaction(txSignature, {
      encoding: "json",
      maxSupportedTransactionVersion: 0,
    })
    .send();

  if (!tx) return null;

  const instructions = tx.transaction.message.instructions as ReadonlyArray<{
    data: string; // base58-encoded, json encoding
  }>;

  const firstInstruction = instructions[0];
  if (!firstInstruction?.data) return null;

  // data is a base58 STRING; encode converts it into the original bytes.
  const base58Encoder = getBase58Encoder();
  const dataBytes = base58Encoder.encode(firstInstruction.data);

  return new TextDecoder().decode(dataBytes);
}
