import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const KEY_PATH = resolve(import.meta.dirname, "..", "data", ".secret-key");
let keyPromise;

async function getKey({ create }) {
  if (!keyPromise) keyPromise = loadKey({ create });
  try {
    return await keyPromise;
  } catch (error) {
    keyPromise = undefined;
    throw error;
  }
}

async function loadKey({ create }) {
  let key;
  try {
    key = await readFile(KEY_PATH);
  } catch (error) {
    if (!create || error?.code !== "ENOENT") throw error;
    key = randomBytes(32);
    await mkdir(dirname(KEY_PATH), { recursive: true });
    try {
      await writeFile(KEY_PATH, key, { flag: "wx", mode: 0o600 });
    } catch (writeError) {
      if (writeError?.code !== "EEXIST") throw writeError;
      key = await readFile(KEY_PATH);
    }
  }
  if (key.length !== 32) throw new Error("Invalid local secret key");
  return key;
}

export async function protectSecret(value) {
  if (!value) return "";
  const key = await getKey({ create: true });
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(String(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

export async function unprotectSecret(value) {
  if (!value) return "";
  const payload = Buffer.from(String(value), "base64");
  if (payload.length < 29) throw new Error("Invalid protected secret");
  const key = await getKey({ create: false });
  const decipher = createDecipheriv("aes-256-gcm", key, payload.subarray(0, 12));
  decipher.setAuthTag(payload.subarray(12, 28));
  return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString("utf8");
}
