import crypto from "node:crypto";

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString("base64url");
export const sha256 = (value: string) => crypto.createHash("sha256").update(value).digest("hex");
export const timingSafeEqualHash = (left: string, right: string) => {
  const a = Buffer.from(sha256(left));
  const b = Buffer.from(sha256(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

export function hashRecoveryCode(code: string, salt = crypto.randomBytes(16).toString("base64url")): string {
  const derived = crypto.scryptSync(code, salt, 32).toString("base64url");
  return `${salt}.${derived}`;
}

export function verifyRecoveryCode(code: string, stored: string): boolean {
  const [salt, expected] = stored.split(".");
  if (!salt || !expected) return false;
  const actual = crypto.scryptSync(code, salt, 32);
  const expectedBuffer = Buffer.from(expected, "base64url");
  return actual.length === expectedBuffer.length && crypto.timingSafeEqual(actual, expectedBuffer);
}

export function verifyEd25519Signature(publicKeyBase64: string, message: string, signatureBase64: string): boolean {
  try {
    const prefix = Buffer.from("302a300506032b6570032100", "hex");
    const publicKey = crypto.createPublicKey({ key: Buffer.concat([prefix, Buffer.from(publicKeyBase64, "base64")]), format: "der", type: "spki" });
    return crypto.verify(null, Buffer.from(message), publicKey, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}
