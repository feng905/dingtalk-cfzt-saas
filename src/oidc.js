/**
 * oidc.js — 租户感知的 OIDC IdP 端点
 *   GET  /.well-known/openid-configuration
 *   GET  /authorize   入口：校验 client + redirect_uri → 签名 state → 302 钉钉
 *   GET  /cb          钉钉回调：换 token + 拉用户 → corpId 准入 → 铸一次性 code → 302 回 CF
 *   POST /token       code 换 RS256 id_token（jti 一次性消费，防重放）
 *   GET  /userinfo    验自家 JWT 返回 claims
 *   GET  /jwks        租户公钥
 */

import {
  makeSignedToken, readSignedToken, randomHex, signJwt, verifyJwt,
} from "./core.js";
import { dtExchangeCode, dtProfile, toOidcClaims } from "./dingtalk.js";
import {
  tenantSlugFromRequest, lookupClient, verifyClient, getTenant, getDtClientSecret, getTenantKeys,
} from "./tenant.js";

const STATE_PREFIX = "oidc1.";
const CODE_PREFIX = "dtc1.";
const STATE_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 2 * 60 * 1000;
const ID_TOKEN_TTL_S = 600;

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

/** 解析 client 凭证：Basic 头 / form / JSON（body 只读一次，结果传给各分支） */
export async function parseClientCredentials(request) {
  let clientId = null;
  let clientSecret = null;
  const authHeader = request.headers.get("Authorization") || "";
  if (authHeader.startsWith("Basic ")) {
    try {
      const decoded = atob(authHeader.slice(6));
      const idx = decoded.indexOf(":");
      clientId = decoded.slice(0, idx);
      clientSecret = decoded.slice(idx + 1);
    } catch { /* malformed basic */ }
  }
  const contentType = request.headers.get("Content-Type") || "";
  let params;
  if (contentType.includes("application/json")) {
    params = await request.json().catch(() => ({}));
  } else {
    params = Object.fromEntries((await request.formData().catch(() => new FormData())).entries());
  }
  return {
    clientId: clientId || params.client_id || params.clientId || null,
    clientSecret: clientSecret || params.client_secret || params.clientSecret || null,
    code: params.code || null,
    grantType: params.grant_type || params.grantType || "authorization_code",
  };
}

function issuer(request) {
  return `https://${new URL(request.url).hostname}`;
}

async function audit(env, slug, unionId, action, detail, request) {
  try {
    await env.DB.prepare(
      "INSERT INTO audit_log (ts, tenant_slug, union_id, action, detail, ip) VALUES (?, ?, ?, ?, ?, ?)",
    )
      .bind(Date.now(), slug, unionId, action, detail || null, request.headers.get("cf-connecting-ip"))
      .run();
  } catch { /* 审计失败不阻断登录 */ }
}

/* ---------------- discovery / jwks ---------------- */

export function handleDiscovery(request) {
  const iss = issuer(request);
  return json({
    issuer: iss,
    authorization_endpoint: `${iss}/authorize`,
    token_endpoint: `${iss}/token`,
    userinfo_endpoint: `${iss}/userinfo`,
    jwks_uri: `${iss}/jwks`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: ["openid", "email", "profile"],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    claims_supported: [
      "sub", "iss", "aud", "exp", "iat", "nonce",
      "name", "nickname", "preferred_username", "email", "email_verified", "picture",
    ],
  });
}

export async function handleJwks(env, slug) {
  const keys = await getTenantKeys(env, slug);
  return json({ keys: keys.map((k) => k.publicJwk) });
}

/* ---------------- /authorize ---------------- */

export async function handleAuthorize(request, env) {
  const url = new URL(request.url);
  const slug = tenantSlugFromRequest(request, env);
  const clientId = url.searchParams.get("client_id");
  const redirectUri = url.searchParams.get("redirect_uri");
  const cfState = url.searchParams.get("state") || "";
  const nonce = url.searchParams.get("nonce") || "";

  const found = clientId ? await lookupClient(env, clientId) : null;
  if (!found || found.tenant.slug !== slug) {
    return json({ error: "invalid_client", error_description: "unknown client_id" }, 400);
  }
  const { tenant } = found;

  if (!redirectUri || !tenant.allowedRedirects.includes(redirectUri)) {
    return json({ error: "invalid_request", error_description: "redirect_uri not in allowlist" }, 400);
  }

  const state = await makeSignedToken(env.STATE_SECRET, STATE_PREFIX, {
    t: slug,
    r: redirectUri,
    s: cfState,
    n: nonce,
    a: clientId,
    exp: Date.now() + STATE_TTL_MS,
    j: randomHex(8),
  });

  const base = env.DT_LOGIN_BASE || "https://login.dingtalk.com";
  const authUrl = new URL(`${base}/oauth2/auth`);
  authUrl.searchParams.set("client_id", tenant.dtClientId);
  authUrl.searchParams.set("redirect_uri", `${url.origin}/cb`);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid");
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("prompt", "consent");
  return new Response(null, { status: 302, headers: { Location: authUrl.toString() } });
}

/* ---------------- /cb ---------------- */

export async function handleCallback(request, env) {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") || "";
  const ctx = await readSignedToken(env.STATE_SECRET, state, STATE_PREFIX);
  if (!ctx) {
    return json({ error: "invalid_request", error_description: "bad or expired state" }, 400);
  }
  const slug = ctx.t;
  const tenant = await getTenant(env, slug);
  if (!tenant || tenant.status !== "active") {
    return json({ error: "access_denied", error_description: "tenant disabled" }, 403);
  }
  const authCode = url.searchParams.get("authCode") || url.searchParams.get("code");
  if (!authCode) {
    return json({
      error: "access_denied",
      error_description: `dingtalk callback missing authCode; got: ${[...url.searchParams.keys()].join(",")}`,
    }, 400);
  }

  const dtSecret = await getDtClientSecret(env, slug, (await env.DB.prepare(
    "SELECT dt_client_secret_enc FROM tenants WHERE slug = ?",
  ).bind(slug).first()).dt_client_secret_enc);

  const tok = await dtExchangeCode(env, {
    clientId: tenant.dtClientId, clientSecret: dtSecret, code: authCode,
  });
  if (!tok.accessToken) {
    await audit(env, slug, null, "login_fail", `dingtalk token: ${tok.message || tok.code}`, request);
    return json({ error: "invalid_grant", error_description: tok.message || "dingtalk token exchange failed" }, 400);
  }

  // corpId 准入：企业内部应用可被任意钉钉账号扫码，必须在我们的层面拦
  if (!tenant.corpIds.includes("*") && !tenant.corpIds.includes(tok.corpId)) {
    await audit(env, slug, null, "login_fail", `corpId denied: ${tok.corpId || "none"}`, request);
    return json({ error: "access_denied", error_description: "organization not allowed for this tenant" }, 403);
  }

  const dtData = await dtProfile(env, tok.accessToken);
  if (!dtData.unionId) {
    await audit(env, slug, null, "login_fail", `dingtalk profile: ${dtData.message || dtData.code}`, request);
    return json({ error: "invalid_grant", error_description: dtData.message || "dingtalk profile failed" }, 400);
  }

  const claims = toOidcClaims(dtData, tenant.emailMode);
  await audit(env, slug, claims.sub, "login_ok", `corpId=${tok.corpId || "-"}`, request);

  const code = await makeSignedToken(env.STATE_SECRET, CODE_PREFIX, {
    t: slug,
    c: claims,
    n: ctx.n,
    a: ctx.a,
    exp: Date.now() + CODE_TTL_MS,
    j: randomHex(8),
  });

  const back = new URL(ctx.r);
  back.searchParams.set("code", code);
  if (ctx.s) back.searchParams.set("state", ctx.s);
  return new Response(null, { status: 302, headers: { Location: back.toString() } });
}

/* ---------------- /token ---------------- */

export async function handleToken(request, env) {
  const creds = await parseClientCredentials(request);
  const found = await verifyClient(env, creds.clientId, creds.clientSecret);
  if (!found) {
    return json({ error: "invalid_client", error_description: "client authentication failed" }, 401);
  }
  if (creds.grantType !== "authorization_code") {
    return json({ error: "unsupported_grant_type" }, 400);
  }

  const ctx = await readSignedToken(env.STATE_SECRET, creds.code, CODE_PREFIX);
  if (!ctx) {
    return json({ error: "invalid_grant", error_description: "bad or expired code" }, 400);
  }

  // jti 一次性消费：INSERT 冲突 = 重放，拒绝（OIDC 规范要求 code 单次有效）
  try {
    const r = await env.DB.prepare("INSERT INTO used_jti (jti, expires_at) VALUES (?, ?)")
      .bind(ctx.j, ctx.exp)
      .run();
    if (!r.meta || r.meta.changes === 0) throw new Error("duplicate jti");
  } catch {
    return json({ error: "invalid_grant", error_description: "code already used" }, 400);
  }
  env.DB.prepare("DELETE FROM used_jti WHERE expires_at < ?").bind(Date.now()).run().catch(() => {});

  const keys = await getTenantKeys(env, ctx.t, { activeOnly: true });
  if (!keys.length) {
    return json({ error: "server_error", error_description: "no signing key for tenant" }, 500);
  }
  const now = Math.floor(Date.now() / 1000);
  const idToken = await signJwt(keys[0].privatePem, { alg: "RS256", typ: "JWT", kid: keys[0].kid }, {
    iss: issuer(request),
    sub: ctx.c.sub,
    aud: ctx.a,
    exp: now + ID_TOKEN_TTL_S,
    iat: now,
    nonce: ctx.n || undefined,
    name: ctx.c.name,
    nickname: ctx.c.nickname,
    preferred_username: ctx.c.preferred_username,
    email: ctx.c.email,
    email_verified: ctx.c.email_verified,
    picture: ctx.c.picture,
  });

  return json({
    access_token: idToken,
    id_token: idToken,
    token_type: "Bearer",
    expires_in: ID_TOKEN_TTL_S,
    scope: "openid email profile",
  });
}

/* ---------------- /userinfo ---------------- */

export async function handleUserinfo(request, env, slug) {
  const authHeader = request.headers.get("Authorization") || "";
  if (!authHeader.startsWith("Bearer ")) {
    return json({ error: "invalid_token", error_description: "Authorization: Bearer required" }, 401);
  }
  const token = authHeader.slice(7).trim();
  for (const key of await getTenantKeys(env, slug)) {
    const payload = await verifyJwt(key.publicJwk, token);
    if (payload) {
      return json({
        sub: payload.sub,
        name: payload.name,
        nickname: payload.nickname,
        preferred_username: payload.preferred_username,
        email: payload.email,
        email_verified: payload.email_verified,
        picture: payload.picture,
      });
    }
  }
  return json({ error: "invalid_token", error_description: "bad or expired token" }, 401);
}
