/**
 * Solana RPC integration utilities.
 *
 * This module is the only layer within majik-notary that communicates directly
 * with the Solana network through @solana/kit.
 *
 * Responsibilities:
 * - Create RPC clients for supported networks.
 * - Build and sign memo transactions.
 * - Submit transactions to the network.
 * - Poll transaction confirmation status.
 * - Read memo data back from confirmed transactions.
 *
 * The API intentionally separates transaction construction, submission, and
 * confirmation polling so callers can implement asynchronous workflows instead
 * of blocking until finalization.
 */

import {
  address,
  createSolanaRpc,
  createTransactionMessage,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  appendTransactionMessageInstructions,
  signTransactionMessageWithSigners,
  getSignatureFromTransaction,
  getBase64EncodedWireTransaction,
  getBase58Encoder,
  signature as brandSignature,
  pipe,
  type Rpc,
  type SolanaRpcApi,
  type KeyPairSigner,
  type Instruction,
  AccountRole,
  type Signature,
  Base64EncodedWireTransaction,
} from "@solana/kit";

import { MEMO_PROGRAM_ADDRESS, type NotaryNetwork } from "./constants";
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
    throw new Error(`No RPC URL configured for network: ${network}`);
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
 * The memo program itself requires no accounts, but the fee payer is included
 * as a read-only signer so transaction authorship is visible in explorers.
 */
function buildMemoInstruction(
  memo: string,
  feePayerAddress: ReturnType<typeof address>,
): Instruction {
  return {
    programAddress: address(MEMO_PROGRAM_ADDRESS),
    accounts: [
      {
        address: feePayerAddress,
        role: AccountRole.READONLY_SIGNER,
      },
    ],
    data: new TextEncoder().encode(memo),
  };
}

export interface BuiltTransaction {
  /** Serialized transaction ready for sendTransaction(). */
  wireTransaction: Base64EncodedWireTransaction;

  /** Transaction signature computed during signing. */
  signature: Signature;
}

/**
 * Builds and signs the memo transaction used to register a chain anchor.
 *
 * The transaction is prepared for submission but is not broadcast to the
 * network. Call submitTransaction() to send it.
 */
export async function buildRegisterTransaction(
  memo: string,
  feePayerSigner: KeyPairSigner,
  rpc: Rpc<SolanaRpcApi>,
): Promise<BuiltTransaction> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

  const instruction = buildMemoInstruction(memo, feePayerSigner.address);

  const transactionMessage = pipe(
    createTransactionMessage({ version: 0 }),
    (tx) => setTransactionMessageFeePayerSigner(feePayerSigner, tx),
    (tx) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, tx),
    (tx) => appendTransactionMessageInstructions([instruction], tx),
  );

  const signedTransaction =
    await signTransactionMessageWithSigners(transactionMessage);
  const signature = getSignatureFromTransaction(signedTransaction);
  const wireTransaction = getBase64EncodedWireTransaction(signedTransaction);

  return { wireTransaction, signature };
}

/**
 * Broadcasts a previously built transaction.
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
 * than `jsonParsed`. The memo instruction data is decoded locally instead of
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
    data: string; // base58-encoded, "json" encoding
  }>;

  const firstInstruction = instructions[0];
  if (!firstInstruction?.data) return null;

  // "data" is a base58 STRING; we want the raw bytes it represents, so this
  // is the encode direction (string -> bytes), not decode (bytes -> string).
  const base58Encoder = getBase58Encoder();
  const dataBytes = base58Encoder.encode(firstInstruction.data);

  return new TextDecoder().decode(dataBytes.slice());
}
