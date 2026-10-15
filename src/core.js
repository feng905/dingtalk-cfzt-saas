/**
 * core.js — 通用加密/编码原语（WebCrypto，Workers 兼容）
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ---------------- base64url / hex ---------------- */

export function b64url(bytes) {
  let s = btoa(String.fromCharCode(...bytes));
  return s.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecodeBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

export const b64urlJson = (obj) => b64url(enc.encode(JSON.stringify(obj)));
export const jsonFromB64url = (s) => JSON.parse(dec.decode(b64urlDecodeBytes(s)));

export function randomHex(nBytes) {
  return [...crypto.getRandomValues(new Uint8Array(nBytes))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export async function sha256Hex(text) {
  const d = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 常量时间比较（长度泄露可接受） */
export function safeEq(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* ---------------- HMAC 签名 token（state / 一次性 code） ---------------- */

async function hmacSign(secret, payloadB64) {
  const key = await crypto.subtle.importKey(
    "raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(payloadB64));
  return b64url(new Uint8Array(sig));
}

export async function makeSignedToken(secret, prefix, payload) {
  const payloadB64 = b64urlJson(payload);
  return `${prefix}${payloadB64}.${await hmacSign(secret, payloadB64)}`;
}

/** 校验并解码签名 token；过期/篡改/前缀不符返回 null。payload 需带 exp（ms epoch） */
export async function readSignedToken(secret, token, expectedPrefix) {
  if (!token || !token.startsWith(expectedPrefix)) return null;
  const parts = token.slice(expectedPrefix.length).split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts;
  if (!safeEq(sig, await hmacSign(secret, payloadB64))) return null;
  let payload;
  try {
    payload = jsonFromB64url(payloadB64);
  } catch {
    return null;
  }
  if (!payload.exp || Date.now() > payload.exp) return null;
  return payload;
}

/* ---------------- AES-GCM 字段级加密（落库的密钥/凭证） ---------------- */

async function aesKey(keyHex) {
  return crypto.subtle.importKey("raw", hexToBytes(keyHex), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** 返回 "iv.ct"（均 b64url） */
export async function aesEncrypt(keyHex, plaintext) {
  const key = await aesKey(keyHex);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, enc.encode(plaintext));
  return `${b64url(iv)}.${b64url(new Uint8Array(ct))}`;
}

export async function aesDecrypt(keyHex, stored) {
  const [ivB64, ctB64] = stored.split(".");
  const key = await aesKey(keyHex);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: b64urlDecodeBytes(ivB64) },
    key,
    b64urlDecodeBytes(ctB64),
  );
  return dec.decode(pt);
}

/* ---------------- PEM / RSA ---------------- */

export function derToPem(der, label) {
  const bytes = der instanceof Uint8Array ? der : new Uint8Array(der); // exportKey 返回 ArrayBuffer
  const b64 = btoa(String.fromCharCode(...bytes)).replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----`;
}

export function pemToDer(pem) {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** 生成租户 RSA-2048 密钥对（ kid 随机） */
export async function generateRsaKey() {
  const kid = randomHex(8);
  const kp = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
  const jwk = await crypto.subtle.exportKey("jwk", kp.publicKey);
  return {
    kid,
    privatePem: derToPem(pkcs8, "PRIVATE KEY"),
    publicJwk: { kty: jwk.kty, n: jwk.n, e: jwk.e, kid, alg: "RS256", use: "sig" },
  };
}

/* ---------------- RS256 JWT ---------------- */

async function importSignKey(privatePem) {
  return crypto.subtle.importKey(
    "pkcs8", pemToDer(privatePem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"],
  );
}

export async function signJwt(privatePem, header, payload) {
  const key = await importSignKey(privatePem);
  const signingInput =
    `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(signingInput));
  return `${signingInput}.${b64url(new Uint8Array(sig))}`;
}

async function importVerifyKey(jwk) {
  return crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );
}

/** 验 RS256 JWT；成功返回 payload，失败返回 null。校验 kid 匹配 + exp */
export async function verifyJwt(publicJwk, token) {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header, payload;
  try {
    header = jsonFromB64url(h);
    payload = jsonFromB64url(p);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || header.kid !== publicJwk.kid) return null;
  const key = await importVerifyKey(publicJwk);
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlDecodeBytes(s), enc.encode(`${h}.${p}`),
  );
  if (!ok) return null;
  if (payload.exp && payload.exp * 1000 < Date.now()) return null;
  return payload;
}
