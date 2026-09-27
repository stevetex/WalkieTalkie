// Generates a session signing key pair for deploy/gcp/setup-api.sh, as JSON on stdout:
//   {"signingKey": {"kid", "privateKey"}, "publicKeys": {"<kid>": "<PEM>"}}
// It refuses to write to a terminal, so the private key only ever goes into a pipe.
//
//   node tools/session-key.ts <kid> | …
//   node tools/session-key.ts --public    reads that JSON's signingKey on stdin and prints
//                                         {"<kid>": "<public PEM>"} (not secret)

import { readFileSync } from "node:fs";
import { SessionSigner, generateSigningKey, parseSigningKey } from "../src/session.ts";

const arg = process.argv[2];
if (arg === "--public") {
  const signer = new SessionSigner(parseSigningKey(readFileSync(0, "utf8")));
  process.stdout.write(JSON.stringify({ [signer.kid]: signer.publicKey() }));
} else {
  if (!arg || !/^[\w-]+$/.test(arg)) {
    console.error("usage: node tools/session-key.ts <kid> | …");
    process.exit(2);
  }
  if (process.stdout.isTTY) {
    console.error("Refusing to print a private key to the terminal; pipe it somewhere.");
    process.exit(1);
  }
  process.stdout.write(JSON.stringify(generateSigningKey(arg)));
}
