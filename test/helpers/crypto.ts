// test/helpers/crypto.ts
import { MajikKey } from "@majikah/majik-key";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Generates a fresh, fully-upgraded, and UNLOCKED MajikKey for testing.
 * Uses a 128-bit mnemonic for faster test execution.
 */
export async function getTestKey(): Promise<MajikKey> {
  // Return a pre-seeded or quickly generated key for testing

  const testPassphrase = "test_passphrase";

  const generatedMnemonic = await MajikKey.generateMnemonic();

  const key = await MajikKey.create(
    generatedMnemonic,
    testPassphrase,
    "Test Account",
  );

  return key;
}

export async function loadFixtureKey(index: 1 | 2 | 3 | 4): Promise<MajikKey> {
  const file = join(
    process.cwd(),
    "test",
    "fixtures",
    "keys",
    `signer${index}.json`,
  );

  const json = JSON.parse(await readFile(file, "utf8"));

  return MajikKey.fromDangerousJSON(json);
}

export async function loadFixtureKeys() {
  const keys = await Promise.all(
    [1, 2, 3, 4].map(async (i) => {
      const json = JSON.parse(
        await readFile(
          join(process.cwd(), "test", "fixtures", "keys", `signer${i}.json`),
          "utf8",
        ),
      );

      return MajikKey.fromDangerousJSON(json);
    }),
  );

  return {
    keyA: keys[0],
    keyB: keys[1],
    keyC: keys[2],
    keyD: keys[3],
  };
}

export async function loadFixtureSigners() {
  const keys = await Promise.all([
    loadFixtureKey(1),
    loadFixtureKey(2),
    loadFixtureKey(3),
    loadFixtureKey(4),
  ]);

  const signers = await Promise.all(keys.map((k) => k.getSolanaKeypair()));

  return {
    keys,
    signers,
  };
}
