/**
 * tenant.js — 多租户解析与配置访问（D1）
 */

import { aesDecrypt, sha256Hex, safeEq } from "./core.js";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * Host → 租户 slug。
 * 生产：<slug>.<SSO_BASE_DOMAIN>；本地 dev（localhost）用 x-dev-tenant 头或 DEV_TENANT。
 */
export function tenantSlugFromRequest(request, env) {
  let hostname;
  try {
    hostname = new URL(request.url).hostname;
  } catch {
    return null;
  }
  const base = env.SSO_BASE_DOMAIN;
  if (base && hostname.endsWith("." + base)) {
    const slug = hostname.slice(0, -(base.length + 1));
    return SLUG_RE.test(slug) ? slug : null;
  }
  // 本地开发兜底
  if (["localhost", "127.0.0.1", "0.0.0.0"].includes(hostname)) {
    const dev = request.headers.get("x-dev-tenant") || env.DEV_TENANT || null;
    return dev && SLUG_RE.test(dev) ? dev : null;
  }
  return null;
}

/** CF Access 回调形态校验；any_redirect=1 的租户可豁免（自定义 Access 域） */
export function isValidCfRedirect(uri, anyRedirect) {
  if (anyRedirect) return /^https:\/\/[^\s/]+$/.test(uri || "");
  try {
    const u = new URL(uri);
    return (
      u.protocol === "https:" &&
      u.hostname.endsWith(".cloudflareaccess.com") &&
      u.pathname === "/cdn-cgi/access/callback" &&
      u.search === "" &&
      u.hash === ""
    );
  } catch {
    return false;
  }
}

function parseTenant(row) {
  if (!row) return null;
  return {
    slug: row.slug,
    status: row.status,
    corpIds: JSON.parse(row.corp_ids || "[]"),
    dtClientId: row.dt_client_id,
    allowedRedirects: JSON.parse(row.allowed_redirects || "[]"),
    anyRedirect: !!row.any_redirect,
    emailMode: row.email_mode,
    createdAt: row.created_at,
  };
}

export async function getTenant(env, slug) {
  const row = await env.DB.prepare("SELECT * FROM tenants WHERE slug = ?").bind(slug).first();
  return parseTenant(row);
}

/** 解密钉钉 AppSecret（调用方按需缓存） */
export async function getDtClientSecret(env, slug, encSecret) {
  return aesDecrypt(env.ENCRYPTION_KEY, encSecret);
}

/** client_id → {client, tenant}；找不到返回 null */
export async function lookupClient(env, clientId) {
  const client = await env.DB.prepare(
    "SELECT * FROM oidc_clients WHERE client_id = ? AND status = 'active'",
  )
    .bind(clientId)
    .first();
  if (!client) return null;
  const tenant = await getTenant(env, client.tenant_slug);
  if (!tenant || tenant.status !== "active") return null;
  return { client, tenant };
}

/** client 认证（secret 存哈希）；失败返回 null */
export async function verifyClient(env, clientId, clientSecret) {
  if (!clientId || !clientSecret) return null;
  const found = await lookupClient(env, clientId);
  if (!found) return null;
  const hash = await sha256Hex(clientSecret);
  if (!safeEq(hash, found.client.secret_hash)) return null;
  return found;
}

/* ---------------- 签名密钥（isolate 内缓存，避免每次验签解密） ---------------- */

const _keyCache = new Map(); // kid -> { privatePem, publicJwk }

export async function getTenantKeys(env, slug, { activeOnly = false } = {}) {
  const sql = activeOnly
    ? "SELECT kid, private_key_enc, public_jwk FROM signing_keys WHERE tenant_slug = ? AND status = 'active'"
    : "SELECT kid, private_key_enc, public_jwk FROM signing_keys WHERE tenant_slug = ?";
  const { results } = await env.DB.prepare(sql).bind(slug).all();
  const keys = [];
  for (const row of results || []) {
    let entry = _keyCache.get(row.kid);
    if (!entry) {
      const privatePem = await aesDecrypt(env.ENCRYPTION_KEY, row.private_key_enc);
      entry = { kid: row.kid, privatePem, publicJwk: JSON.parse(row.public_jwk) };
      _keyCache.set(row.kid, entry);
    }
    keys.push(entry);
  }
  return keys;
}

export function invalidateKeyCache(kid) {
  if (kid) _keyCache.delete(kid);
  else _keyCache.clear();
}
