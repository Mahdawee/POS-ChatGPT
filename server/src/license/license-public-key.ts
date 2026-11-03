import { readFileSync } from "node:fs";

/**
 * The vendor's Ed25519 PUBLIC key, embedded at build time. Only the public
 * half ever ships with the application — licenses are issued offline with
 * `tools/license/cli.js` using the private key, which never leaves the
 * vendor's machine. Regenerating the keypair invalidates every issued
 * license, so the private key must be backed up (see tools/license/README.md).
 */
export const LICENSE_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEAQKaMj3bhk+TffKq0c4i4zYfbNNTqOx+P6T5iZ3L6hbk=
-----END PUBLIC KEY-----`;

/** Optional development override: POS_LICENSE_PUBLIC_KEY_FILE=path/to/pem. */
export function licensePublicKey(): string {
  const override = process.env.POS_LICENSE_PUBLIC_KEY_FILE;
  if (override) {
    try {
      return readFileSync(override, "utf8");
    } catch {
      // Fall through to the embedded key.
    }
  }
  return LICENSE_PUBLIC_KEY;
}
