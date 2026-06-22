import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { encryptionKey } from "../config/secrets.js";

const ALGORITHM = "aes-256-gcm";

function getKey(): Buffer {
    const hex = encryptionKey();
    if (hex.length !== 64) {
        throw new Error(
            "ENCRYPTION_KEY must be a 64-char hex string (32 bytes)",
        );
    }

    return Buffer.from(hex, "hex");
}

// Returns "iv:tag:ciphertext" — all hex-encoded
export function encrypt(plaintext: string): string {
    const key = getKey();
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const encrypted = Buffer.concat([
        cipher.update(plaintext, "utf8"),
        cipher.final(),
    ]);
    const tag = cipher.getAuthTag();
    return `${iv.toString("hex")}:${tag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(ciphertext: string): string {
    const key = getKey();
    const parts = ciphertext.split(":");
    if (parts.length !== 3) throw new Error("Invalid ciphertext format");
    const [ivHex, tagHex, dataHex] = parts;
    const iv = Buffer.from(ivHex, "hex");
    const tag = Buffer.from(tagHex, "hex");
    const data = Buffer.from(dataHex, "hex");
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
        "utf8",
    );
}
