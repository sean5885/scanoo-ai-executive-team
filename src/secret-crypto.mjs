import crypto from "node:crypto";

const PREFIX = "enc:v1:";

function deriveKey(secret) {
  return crypto.createHash("sha256").update(String(secret)).digest();
}

export function secretCryptoEnabled(secret) {
  return Boolean(String(secret || "").trim());
}

export function encryptSecretValue(value, secret) {
  const plaintext = String(value || "");
  if (!plaintext || !secretCryptoEnabled(secret)) {
    return plaintext;
  }

  const iv = crypto.randomBytes(12);
  const key = deriveKey(secret);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString("base64")}.${tag.toString("base64")}.${encrypted.toString("base64")}`;
}

export function decryptSecretValue(value, secret) {
  const raw = String(value || "");
  if (!raw || !raw.startsWith(PREFIX)) {
    return raw;
  }
  if (!secretCryptoEnabled(secret)) {
    throw new Error("missing_secret_crypto_key");
  }

  const payload = raw.slice(PREFIX.length);
  const [ivB64, tagB64, encryptedB64] = payload.split(".");
  if (!ivB64 || !tagB64 || !encryptedB64) {
    throw new Error("invalid_secret_payload");
  }

  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    deriveKey(secret),
    Buffer.from(ivB64, "base64"),
  );
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encryptedB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}
