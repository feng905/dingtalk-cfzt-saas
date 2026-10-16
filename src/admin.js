/**
 * admin.js — 租户管理 API（Bearer ADMIN_TOKEN）+ HTML 控制台
 *
 * POST   /admin/tenants                     建租户（返回 client_id/secret；配好域名 API 时自动开通租户域名）
 * GET    /admin/tenants                     列表
 * GET    /admin/tenants/:slug               详情
 * PATCH  /admin/tenants/:slug               改配置（corpIds/redirects/emailMode/status/anyRedirect）
 * DELETE /admin/tenants/:slug               停用（软删）
 * POST   /admin/tenants/:slug/rotate-key    轮换签名密钥（旧 key 转 retiring，仍可验签）
 * POST   /admin/tenants/:slug/rotate-client-secret  重置 OIDC client secret
 * GET    /admin/tenants/:slug/client-secret 再次查看 client secret（密文存储，按需解密）
 * POST   /admin/tenants/:slug/domain        开通租户域名（挂 Custom Domain，自动 DNS+证书）
 * DELETE /admin/tenants/:slug/domain        摘掉租户域名
 * GET    /admin/tenants/:slug/logs?limit=50 登录审计
 * GET    /admin/                            HTML 控制台
 */

import {
  randomHex, sha256Hex, safeEq, generateRsaKey, aesEncrypt, aesDecrypt,
} from "./core.js";
import { isValidCfRedirect } from "./tenant.js";
import { provisionDomain, detachDomain } from "./cfapi.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const err = (msg, status = 400) => json({ error: msg }, status);

function checkAuth(request, env) {
  const h = request.headers.get("Authorization") || "";
  if (!h.startsWith("Bearer ")) return false;
  return safeEq(h.slice(7).trim(), env.ADMIN_TOKEN || "");
}

/* 旧库升级：oidc_clients.secret_enc（client secret 密文，供控制台再次查看）。
   幂等：已存在列时 ALTER 报错被吞掉；进程内只跑一次。 */
let colsReady = false;
async function ensureColumns(env) {
  if (colsReady) return;
  try {
    await env.DB.prepare("ALTER TABLE oidc_clients ADD COLUMN secret_enc TEXT").run();
  } catch (e) { /* 列已存在 */ }
  colsReady = true;
}

const EMAIL_MODES = ["synthetic", "prefer_real"];

/** 校验租户入参，返回 {ok, error|fields} */
function validateTenantInput(body, { anyRedirect = false, partial = false } = {}) {
  const out = {};
  if (!partial || body.corpIds !== undefined) {
    if (!Array.isArray(body.corpIds) || body.corpIds.length === 0) {
      return { error: "corpIds must be a non-empty array (use [\"*\"] to allow any)" };
    }
    out.corpIds = body.corpIds.map(String);
  }
  if (!partial || body.dtClientId !== undefined) {
    if (!body.dtClientId || typeof body.dtClientId !== "string") return { error: "dtClientId required" };
    out.dtClientId = body.dtClientId.trim();
  }
  if (!partial || body.dtClientSecret !== undefined) {
    if (!body.dtClientSecret || typeof body.dtClientSecret !== "string") return { error: "dtClientSecret required" };
    out.dtClientSecret = body.dtClientSecret;
  }
  if (!partial || body.redirects !== undefined) {
    if (!Array.isArray(body.redirects) || body.redirects.length === 0) {
      return { error: "redirects must be a non-empty array" };
    }
    for (const r of body.redirects) {
      if (!isValidCfRedirect(r, anyRedirect)) {
        return { error: `redirect not allowed: ${r} (expected https://<team>.cloudflareaccess.com/cdn-cgi/access/callback)` };
      }
    }
    out.redirects = body.redirects;
  }
  if (body.emailMode !== undefined) {
    if (!EMAIL_MODES.includes(body.emailMode)) return { error: `emailMode must be one of ${EMAIL_MODES.join("/")}` };
    out.emailMode = body.emailMode;
  }
  if (body.status !== undefined) {
    if (!["active", "disabled"].includes(body.status)) return { error: "status must be active/disabled" };
    out.status = body.status;
  }
  if (body.anyRedirect !== undefined) out.anyRedirect = body.anyRedirect ? 1 : 0;
  return { ok: true, fields: out };
}

/* ---------------- handlers ---------------- */

async function createTenant(request, env) {
  const body = await request.json().catch(() => ({}));
  const slug = String(body.slug || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(slug)) {
    return err("slug must match ^[a-z0-9][a-z0-9-]{0,31}$");
  }
  const v = validateTenantInput(body, { anyRedirect: !!body.anyRedirect });
  if (v.error) return err(v.error);
  const f = v.fields;

  // 生成 OIDC client 凭证 + 签名密钥
  const clientId = randomHex(16);
  const clientSecret = randomHex(24);
  const key = await generateRsaKey();

  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO tenants (slug, status, corp_ids, dt_client_id, dt_client_secret_enc, allowed_redirects, any_redirect, email_mode, created_at, updated_at) VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(slug, JSON.stringify(f.corpIds), f.dtClientId,
        await aesEncrypt(env.ENCRYPTION_KEY, body.dtClientSecret || ""),
        JSON.stringify(f.redirects), f.anyRedirect ?? 0, f.emailMode || "synthetic", now, now),
      env.DB.prepare(
        "INSERT INTO oidc_clients (client_id, tenant_slug, secret_hash, secret_enc, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
      ).bind(clientId, slug, await sha256Hex(clientSecret),
        await aesEncrypt(env.ENCRYPTION_KEY, clientSecret), now),
      env.DB.prepare(
        "INSERT INTO signing_keys (tenant_slug, kid, private_key_enc, public_jwk, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
      ).bind(slug, key.kid, await aesEncrypt(env.ENCRYPTION_KEY, key.privatePem),
        JSON.stringify(key.publicJwk), now),
    ]);
  } catch (e) {
    const msg = String(e);
    if (msg.includes("UNIQUE") && msg.includes("tenants")) return err("slug already exists", 409);
    if (msg.includes("UNIQUE") && msg.includes("dt_client_id")) return err("dtClientId already used by another tenant", 409);
    return err(`db error: ${msg}`, 500);
  }

  // 域名自动开通：配好 CF API 后建租户即上线；未配置时提示走部署脚本
  const host = `${slug}.${env.SSO_BASE_DOMAIN}`;
  const prov = await provisionDomain(env, host).catch((e) => ({ state: "error", detail: String(e) }));

  return json({
    slug,
    provision: { hostname: host, ...prov },
    // client_secret 只此一次明文展示（之后可经 /client-secret 按需查看）
    oidc: {
      issuer: `https://${host}`,
      client_id: clientId,
      client_secret: clientSecret,
    },
    kid: key.kid,
  }, 201);
}

async function listTenants(env) {
  const { results } = await env.DB.prepare(
    `SELECT t.slug, t.status, t.email_mode, t.any_redirect, t.created_at, c.client_id
     FROM tenants t LEFT JOIN oidc_clients c ON c.tenant_slug = t.slug AND c.status = 'active'
     ORDER BY t.created_at`,
  ).all();
  return json({ tenants: (results || []).map((r) => ({
    slug: r.slug,
    status: r.status,
    emailMode: r.email_mode,
    anyRedirect: !!r.any_redirect,
    clientId: r.client_id,
    createdAt: r.created_at,
  })) });
}

async function getTenantDetail(env, slug) {
  const row = await env.DB.prepare(
    `SELECT t.slug, t.status, t.corp_ids, t.dt_client_id, t.allowed_redirects, t.any_redirect, t.email_mode, t.created_at, t.updated_at, c.client_id
     FROM tenants t LEFT JOIN oidc_clients c ON c.tenant_slug = t.slug AND c.status = 'active'
     WHERE t.slug = ?`,
  ).bind(slug).first();
  if (!row) return err("tenant not found", 404);
  return json({
    slug: row.slug,
    status: row.status,
    corpIds: JSON.parse(row.corp_ids),
    dtClientId: row.dt_client_id,
    redirects: JSON.parse(row.allowed_redirects),
    anyRedirect: !!row.any_redirect,
    emailMode: row.email_mode,
    clientId: row.client_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

async function patchTenant(request, env, slug) {
  const exists = await env.DB.prepare("SELECT any_redirect FROM tenants WHERE slug = ?").bind(slug).first();
  if (!exists) return err("tenant not found", 404);
  const body = await request.json().catch(() => ({}));
  const v = validateTenantInput(body, { anyRedirect: !!exists.any_redirect || !!body.anyRedirect, partial: true });
  if (v.error) return err(v.error);
  const f = v.fields;
  const sets = ["updated_at = ?"];
  const binds = [Date.now()];
  if (f.corpIds !== undefined) { sets.push("corp_ids = ?"); binds.push(JSON.stringify(f.corpIds)); }
  if (f.redirects !== undefined) { sets.push("allowed_redirects = ?"); binds.push(JSON.stringify(f.redirects)); }
  if (f.emailMode !== undefined) { sets.push("email_mode = ?"); binds.push(f.emailMode); }
  if (f.status !== undefined) { sets.push("status = ?"); binds.push(f.status); }
  if (f.anyRedirect !== undefined) { sets.push("any_redirect = ?"); binds.push(f.anyRedirect); }
  binds.push(slug);
  await env.DB.prepare(`UPDATE tenants SET ${sets.join(", ")} WHERE slug = ?`).bind(...binds).run();
  return getTenantDetail(env, slug);
}

async function disableTenant(env, slug) {
  const r = await env.DB.prepare(
    "UPDATE tenants SET status = 'disabled', updated_at = ? WHERE slug = ?",
  ).bind(Date.now(), slug).run();
  if (!r.meta || r.meta.changes === 0) return err("tenant not found", 404);
  return json({ slug, status: "disabled" });
}

async function rotateKey(env, slug) {
  const exists = await env.DB.prepare("SELECT slug FROM tenants WHERE slug = ?").bind(slug).first();
  if (!exists) return err("tenant not found", 404);
  const key = await generateRsaKey();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE signing_keys SET status = 'retiring' WHERE tenant_slug = ? AND status = 'active'",
    ).bind(slug),
    env.DB.prepare(
      "INSERT INTO signing_keys (tenant_slug, kid, private_key_enc, public_jwk, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
    ).bind(slug, key.kid, await aesEncrypt(env.ENCRYPTION_KEY, key.privatePem),
      JSON.stringify(key.publicJwk), now),
  ]);
  return json({ slug, newKid: key.kid, note: "old key now retiring (still verifies at /userinfo and /jwks)" }, 201);
}

async function rotateClientSecret(env, slug) {
  const newSecret = randomHex(24);
  const r = await env.DB.prepare(
    "UPDATE oidc_clients SET secret_hash = ?, secret_enc = ? WHERE tenant_slug = ? AND status = 'active'",
  ).bind(await sha256Hex(newSecret), await aesEncrypt(env.ENCRYPTION_KEY, newSecret), slug).run();
  if (!r.meta || r.meta.changes === 0) return err("no active client for tenant", 404);
  return json({ slug, client_secret: newSecret }, 201);
}

/** 再次查看 client secret（AES 密文解密；旧租户没存密文时引导重置） */
async function revealClientSecret(env, slug) {
  const row = await env.DB.prepare(
    "SELECT secret_enc FROM oidc_clients WHERE tenant_slug = ? AND status = 'active'",
  ).bind(slug).first();
  if (!row) return err("no active client for tenant", 404);
  if (!row.secret_enc) return err("该租户的 secret 建于旧版本未存储密文，请重置 Client Secret", 404);
  return json({ slug, client_secret: await aesDecrypt(env.ENCRYPTION_KEY, row.secret_enc) });
}

/** 开通/摘掉租户域名（Worker 自服务，调 Cloudflare API） */
async function tenantDomain(env, slug, method) {
  const exists = await env.DB.prepare("SELECT slug FROM tenants WHERE slug = ?").bind(slug).first();
  if (!exists) return err("tenant not found", 404);
  const host = `${slug}.${env.SSO_BASE_DOMAIN}`;
  const fn = method === "DELETE" ? detachDomain : provisionDomain;
  const r = await fn(env, host).catch((e) => ({ state: "error", detail: String(e) }));
  return json({ hostname: host, ...r }, r.state === "error" ? 502 : 200);
}

async function tenantLogs(request, env, slug) {
  const limit = Math.min(parseInt(new URL(request.url).searchParams.get("limit") || "50", 10) || 50, 200);
  const { results } = await env.DB.prepare(
    "SELECT ts, union_id, action, detail, ip FROM audit_log WHERE tenant_slug = ? ORDER BY ts DESC LIMIT ?",
  ).bind(slug, limit).all();
  return json({ logs: results || [] });
}

/* ---------------- 路由 ---------------- */

export async function handleAdmin(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/admin";
  const m = path.match(/^\/admin\/tenants\/([a-z0-9-]+)(\/.*)?$/);

  try {
    // HTML 控制台外壳无需令牌即可打开（令牌在页面里输入、只存浏览器本地）；
    // 下方所有数据 API 仍要求 Bearer ADMIN_TOKEN
    if (path === "/admin") {
      return new Response(adminHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (!checkAuth(request, env)) return err("unauthorized", 401);
    await ensureColumns(env);

    if (path === "/admin/tenants" && request.method === "POST") return await createTenant(request, env);
    if (path === "/admin/tenants" && request.method === "GET") return await listTenants(env);
    if (m) {
      const slug = m[1];
      const sub = m[2] || "";
      if (sub === "" && request.method === "GET") return await getTenantDetail(env, slug);
      if (sub === "" && request.method === "PATCH") return await patchTenant(request, env, slug);
      if (sub === "" && request.method === "DELETE") return await disableTenant(env, slug);
      if (sub === "/rotate-key" && request.method === "POST") return await rotateKey(env, slug);
      if (sub === "/rotate-client-secret" && request.method === "POST") return await rotateClientSecret(env, slug);
      if (sub === "/client-secret" && request.method === "GET") return await revealClientSecret(env, slug);
      if (sub === "/domain" && request.method === "POST") return await tenantDomain(env, slug, "POST");
      if (sub === "/domain" && request.method === "DELETE") return await tenantDomain(env, slug, "DELETE");
      if (sub === "/logs" && request.method === "GET") return await tenantLogs(request, env, slug);
    }
    return err("not found", 404);
  } catch (e) {
    return err(String(e), 500);
  }
}

/* ---------------- HTML 控制台（令牌只存浏览器本地；数据 API 仍需 Bearer） ---------------- */

function adminHtml() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DingTalk → CF ZT 控制台</title>
<style>
  :root{
    --bg:#F6F8FA; --fg:#1C2530; --muted:#5F6E7E; --line:#DCE3EA; --card:#FFFFFF;
    --dt:#0B5FD9; --dt-soft:#E7F0FE; --cf:#B54E0E; --cf-soft:#FDEEDF;
    --code-bg:#EEF2F6; --danger:#B42318; --danger-soft:#FDECEA; --ok:#1B7F4B; --ok-soft:#E8F5EE;
    --serif:"Noto Serif SC","Songti SC",serif; --sans:"Noto Sans SC","PingFang SC",sans-serif;
    --mono:"JetBrains Mono","SF Mono",Menlo,monospace;
  }
  @media (prefers-color-scheme:dark){ :root:not([data-theme="light"]){
    --bg:#131A22; --fg:#E8EDF2; --muted:#94A4B5; --line:#2A3542; --card:#1A2330;
    --dt:#71A8FF; --dt-soft:#17273F; --cf:#FFA05C; --cf-soft:#33230F;
    --code-bg:#202B38; --danger:#FF8A7A; --danger-soft:#3A1D18; --ok:#5BC48A; --ok-soft:#14301F;
  }}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--fg);font-family:var(--sans);font-size:15px;line-height:1.6}
  main{max-width:880px;margin:0 auto;padding:0 20px 64px}
  h1{font-family:var(--serif);font-size:1.45rem;margin:0 0 .2em}
  h2{font-family:var(--serif);font-size:1.1rem;margin:2.2rem 0 .6rem;display:flex;align-items:center;gap:.5em;flex-wrap:wrap}
  h2 .tag{font-family:var(--sans);font-size:.68rem;font-weight:400;color:var(--muted)}
  h3{font-size:.92rem;margin:.2rem 0 .4rem;display:flex;align-items:center;gap:.5em}
  .sub{color:var(--muted);font-size:.85rem;margin-bottom:1.2rem}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:1.1rem 1.2rem;margin:.8rem 0}
  .card.dt{border-top:3px solid var(--dt)} .card.cf{border-top:3px solid var(--cf)}
  label{display:block;font-size:.8rem;color:var(--muted);margin:.7rem 0 .25rem}
  label b{color:var(--fg);font-weight:600}
  input,select{width:100%;padding:.5rem .65rem;border:1px solid var(--line);border-radius:8px;
    font-size:.9rem;background:var(--bg);color:var(--fg);font-family:var(--sans)}
  input.mono{font-family:var(--mono);font-size:.82rem}
  .row{display:grid;grid-template-columns:1fr 1fr;gap:0 1rem}
  @media (max-width:640px){.row{grid-template-columns:1fr}}
  button{padding:.5rem 1.1rem;border:0;border-radius:8px;background:var(--dt);color:#fff;
    font-size:.88rem;cursor:pointer;font-family:var(--sans)}
  button:hover{filter:brightness(1.08)}
  button.sec{background:var(--code-bg);color:var(--fg);border:1px solid var(--line)}
  button.warn{background:var(--danger)}
  button.sm{padding:.3rem .7rem;font-size:.78rem}
  .hint{font-size:.8rem;color:var(--muted);margin-top:.35rem}
  .hint code,.tl-code{font-family:var(--mono);font-size:.78rem;background:var(--code-bg);
    padding:.1em .4em;border-radius:5px}
  .frow{display:flex;align-items:center;gap:.6rem;padding:.55rem 0;border-bottom:1px dashed var(--line)}
  .frow:last-child{border-bottom:0}
  .frow .fname{flex:0 0 150px;font-size:.8rem;color:var(--muted)}
  .frow .fval{flex:1;font-family:var(--mono);font-size:.82rem;word-break:break-all;min-width:0;
    background:var(--code-bg);padding:.35rem .55rem;border-radius:6px}
  .frow button{flex:0 0 auto}
  .group{border-left:3px solid var(--dt);background:var(--dt-soft);padding:.5rem .8rem;border-radius:0 8px 8px 0;font-size:.85rem;margin:.8rem 0}
  .group.cf{border-left-color:var(--cf);background:var(--cf-soft)}
  .group.ok{border-left-color:var(--ok);background:var(--ok-soft)}
  .group.bad{border-left-color:var(--danger);background:var(--danger-soft)}
  .steps{margin:.4rem 0 .2rem;padding-left:1.3em;font-size:.85rem}
  .steps li{margin:.3rem 0}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  th,td{padding:.5rem .4rem;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
  th{color:var(--muted);font-weight:500;font-size:.78rem}
  td code{font-family:var(--mono);font-size:.78rem}
  .badge{display:inline-block;font-size:.72rem;padding:.1em .55em;border-radius:99px;
    background:var(--dt-soft);color:var(--dt)}
  .badge.off{background:var(--danger-soft);color:var(--danger)}
  .acts{display:flex;gap:.35rem;flex-wrap:wrap}
  pre{background:var(--code-bg);padding:.8rem 1rem;border-radius:8px;overflow:auto;
    font-size:.76rem;font-family:var(--mono);white-space:pre-wrap;word-break:break-all}
  #toast{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:var(--fg);
    color:var(--bg);padding:.5rem 1.1rem;border-radius:99px;font-size:.85rem;opacity:0;
    transition:opacity .25s;pointer-events:none;z-index:9}
  #toast.show{opacity:1}
  .hide{display:none}
</style>
</head>
<body>
<main>
<h1>钉钉 → Cloudflare Zero Trust 控制台</h1>
<p class="sub">Admin Token 只保存在本浏览器（localStorage）。本地备份在仓库
<code class="tl-code">.secrets/production/ADMIN_TOKEN.txt</code>。</p>

<h2>1 · 连接 <span class="tag">首次使用填一次</span></h2>
<div class="card">
  <label><b>Admin Token</b></label>
  <div style="display:flex;gap:.6rem">
    <input id="token" type="password" class="mono" placeholder="ADMIN_TOKEN" autocomplete="off">
    <button class="sec" id="btn-load">连接并加载</button>
  </div>
  <p class="hint">提示 unauthorized 就是 token 不对（是 ADMIN_TOKEN，不是租户的 client_secret）。</p>
</div>

<h2>2 · 创建租户 <span class="tag">客户 BYO：用客户钉钉应用的 AppKey/AppSecret</span></h2>
<div class="card">
  <div class="row">
    <div>
      <label><b>slug</b>（子域前缀，决定客户入口域名）</label>
      <input id="f-slug" class="mono" placeholder="acme">
      <p class="hint" id="slug-preview"></p>
    </div>
    <div>
      <label><b>emailMode</b>（id_token 的 email 字段）</label>
      <select id="f-email">
        <option value="synthetic">synthetic —— 合成 union_id@dingtalk.local（默认，稳定）</option>
        <option value="prefer_real">prefer_real —— 优先真实企业邮箱</option>
      </select>
    </div>
    <div>
      <label><b>dtClientId</b>（钉钉 AppKey）</label>
      <input id="f-dtid" class="mono" autocomplete="off">
    </div>
    <div>
      <label><b>dtClientSecret</b>（钉钉 AppSecret）</label>
      <input id="f-dtsec" type="password" class="mono" autocomplete="off">
    </div>
    <div>
      <label><b>corpIds</b>（准入的钉钉组织，JSON 数组；<code class="tl-code">["*"]</code>=不限）</label>
      <input id="f-corp" class="mono" value='["*"]'>
    </div>
    <div>
      <label><b>redirects</b>（客户 CF 团队回调，JSON 数组）</label>
      <input id="f-redirects" class="mono"
        value='["https://REPLACE-team.cloudflareaccess.com/cdn-cgi/access/callback"]'>
      <p class="hint">把 REPLACE-team 换成客户 CF 团队名（xxx.cloudflareaccess.com 的 xxx）。</p>
    </div>
  </div>
  <div style="margin-top:1rem;display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
    <button id="btn-create">创建租户</button>
    <label style="margin:0;font-size:.85rem;color:var(--fg);display:flex;align-items:center;gap:.4em">
      <input type="checkbox" id="f-anyredir" style="width:auto"> 允许任意回调域（客户要用自定义域时勾）
    </label>
  </div>
  <pre id="create-err" class="hide"></pre>
</div>

<div id="created" class="hide"></div>

<h2>租户列表</h2>
<div class="card" style="padding:.4rem .9rem">
  <table>
    <thead><tr><th>slug</th><th>状态</th><th>client_id</th><th>操作</th></tr></thead>
    <tbody id="tbody"><tr><td colspan="4" class="hint">连接后显示</td></tr></tbody>
  </table>
</div>

<div id="detail" class="hide"></div>
<div id="logs" class="hide"></div>

<div id="toast"></div>
</main>
<script>
"use strict";
var $ = function(id){ return document.getElementById(id); };
var BASE = location.hostname.replace(/^deploy-check\\./, "");

function toast(msg){
  var t = $("toast");
  t.textContent = msg; t.classList.add("show");
  setTimeout(function(){ t.classList.remove("show"); }, 1800);
}
function getToken(){ return $("token").value.trim(); }
function api(path, opts){
  opts = opts || {};
  opts.headers = Object.assign({"Content-Type":"application/json",
    "Authorization":"Bearer " + getToken()}, opts.headers || {});
  return fetch("/admin" + path, opts).then(function(r){
    return r.json().then(function(d){
      if (!r.ok) throw new Error(d && d.error ? d.error : ("HTTP " + r.status));
      return d;
    });
  });
}
function copyText(v, btn){
  function done(){ if(btn){ var o=btn.textContent; btn.textContent="已复制"; setTimeout(function(){btn.textContent=o;},1200);} toast("已复制"); }
  function fallback(){
    var ta = document.createElement("textarea");
    ta.value = v; document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch(e) {}
    document.body.removeChild(ta); done();
  }
  if (navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText(v).then(done, fallback);
  else fallback();
}
function el(tag, cls, text){
  var e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}
/* 键值行（带复制按钮） */
function fieldRow(name, value){
  var row = el("div", "frow");
  row.appendChild(el("div", "fname", name));
  row.appendChild(el("div", "fval", value));
  var b = el("button", "sec sm", "复制");
  b.addEventListener("click", function(){ copyText(value, b); });
  row.appendChild(b);
  return row;
}
function card(title, cls){
  var c = el("div", "card" + (cls ? " " + cls : ""));
  c.appendChild(el("h3", null, title));
  return c;
}
function notice(text, kind){
  return el("div", "group" + (kind ? " " + kind : ""), text);
}
/* 探测域名是否已开通：no-cors fetch，DNS 失败会 reject */
function probe(host, out){
  out.style.color = "var(--muted)"; out.textContent = "检测中…";
  fetch("https://" + host + "/health", { mode: "no-cors", cache: "no-store" })
    .then(function(){ out.style.color = "var(--ok)"; out.textContent = "✔ 已开通并可访问"; })
    .catch(function(){ out.style.color = "var(--danger)";
      out.textContent = "✘ 还没开通 —— 点「开通域名」注册后再试"; });
}
/* 开通域名：调 Worker 自服务 API；返回 promise 便于串检测 */
function provisionBtn(host, slug, out){
  var b = el("button", "sec sm", "开通域名");
  b.addEventListener("click", function(){
    out.style.color = "var(--muted)"; out.textContent = "注册中…（DNS + 证书签发约 1-2 分钟）";
    api("/tenants/" + slug + "/domain", { method: "POST" }).then(function(r){
      if (r.state === "created")      { out.style.color = "var(--ok)";    out.textContent = "✔ 已注册，等 1-2 分钟后点「检测」"; }
      else if (r.state === "already") { out.style.color = "var(--ok)";    out.textContent = "✔ 已在本服务名下，点「检测」确认"; }
      else if (r.state === "disabled"){ out.style.color = "var(--cf)";    out.textContent = "· 未配置自动开通 —— 在服务器跑 bash deploy.sh 配置（会引导建 API Token）"; }
      else out.style.color = "var(--danger)", out.textContent = "✘ " + (r.detail || "失败");
    }).catch(function(e){
      out.style.color = "var(--danger)"; out.textContent = "✘ " + e.message;
    });
  });
  return b;
}
function probeBtn(host, out){
  var b = el("button", "sec sm", "检测");
  b.addEventListener("click", function(){ probe(host, out); });
  return b;
}
function domainCard(slug){
  var host = slug + "." + BASE;
  var c = card("租户域名 · https://" + host, "dt");
  var out = el("span"); out.style.fontSize = ".85rem"; out.style.marginLeft = ".5rem";
  var acts = el("div", "acts");
  acts.appendChild(provisionBtn(host, slug, out));
  acts.appendChild(probeBtn(host, out));
  c.appendChild(acts);
  c.appendChild(el("p", "hint", "域名注册 = 挂 Custom Domain，DNS 与证书自动签发；正常 1-2 分钟生效。若自动开通未配置，也可在服务器跑 bash deploy.sh --code-only 注册现有租户域名。"));
  return { card: c, out: out };
}
/* —— CF Access OIDC 五字段卡片 —— */
function cfCard(host, clientId){
  var c = card("在 Cloudflare Zero Trust 填（OIDC 登录方法）", "cf");
  c.appendChild(fieldRow("Auth URL", "https://" + host + "/authorize"));
  c.appendChild(fieldRow("Token URL", "https://" + host + "/token"));
  c.appendChild(fieldRow("Certificate URL", "https://" + host + "/jwks"));
  c.appendChild(fieldRow("Client ID", clientId));
  c.appendChild(el("p", "hint", "Client Secret 用「查看 Secret」取 —— 在下面这一步之后。"));
  var ol = el("ol", "steps");
  [["Cloudflare Dashboard → Zero Trust → 集成 → 标识提供程序 → 添加 → OpenID Connect"],
   ["把上面字段逐个填入，PKCE 不要勾选"],
   ["保存后在该登录方法上点「测试」，用钉钉 App 扫码验证"]].forEach(function(x){
    ol.appendChild(el("li", null, x[0]));
  });
  c.appendChild(ol);
  return c;
}
/* —— 钉钉开放平台卡片 —— */
function dingCard(host, dtClientId, corpIds, emailMode){
  var c = card("在钉钉开放平台填（客户的企业内部应用）", "dt");
  c.appendChild(fieldRow("重定向URL（回调地址）", "https://" + host + "/cb"));
  var ol = el("ol", "steps");
  ol.appendChild(el("li", null, "应用详情 → 安全设置 → 重定向 URL（回调地址）：新增上面这条，必须一字不差（https 和 /cb 路径）"));
  ol.appendChild(el("li", null, "权限管理：开通「通讯录个人信息读权限」（扫码登录读取用户身份必需）"));
  ol.appendChild(el("li", null, "凭证与基础信息里拿到的 AppKey / AppSecret，就是创建租户时填的 dtClientId / dtClientSecret"
    + (dtClientId ? "（当前保存的 AppKey：" + dtClientId + "）" : "")));
  c.appendChild(ol);
  c.appendChild(el("p", "hint", "准入 corpId：" + JSON.stringify(corpIds || [])
    + " —— 不在名单内的钉钉组织扫码会被拒绝。" + (emailMode ? " email 模式：" + emailMode + "。" : "")));
  return c;
}
function secretOnce(host, clientId, clientSecret){
  var c = card("Client Secret（已加密保存，可随时再看）", "cf");
  c.appendChild(fieldRow("Client Secret", clientSecret));
  c.appendChild(el("p", "hint", "服务端只存密文与哈希；租户列表的「查看 Secret」随时可再取。若怀疑泄露请「重置」。"));
  return c;
}

$("slug-preview").textContent = "";
$("f-slug").addEventListener("input", function(){
  var s = this.value.trim().toLowerCase();
  $("slug-preview").textContent = s ? ("入口域名：https://" + s + "." + BASE) : "";
});
$("token").addEventListener("keydown", function(e){ if (e.key === "Enter") $("btn-load").click(); });
$("btn-load").addEventListener("click", function(){
  localStorage.setItem("adminToken", getToken());
  loadTenants();
});
$("btn-create").addEventListener("click", function(){
  var pre = $("create-err"); pre.classList.add("hide");
  var body;
  try {
    body = {
      slug: $("f-slug").value.trim().toLowerCase(),
      dtClientId: $("f-dtid").value.trim(),
      dtClientSecret: $("f-dtsec").value,
      corpIds: JSON.parse($("f-corp").value),
      redirects: JSON.parse($("f-redirects").value),
      emailMode: $("f-email").value,
      anyRedirect: $("f-anyredir").checked
    };
  } catch(e) {
    pre.textContent = "JSON 格式不对: " + e.message; pre.classList.remove("hide"); return;
  }
  api("/tenants", { method: "POST", body: JSON.stringify(body) }).then(function(out){
    var host = body.slug + "." + BASE;
    var box = $("created"); box.classList.remove("hide"); box.textContent = "";
    box.appendChild(el("h2", null, "3 · 按两边提示配置"));
    box.appendChild(dingCard(host, body.dtClientId, body.corpIds, body.emailMode));
    box.appendChild(cfCard(host, out.oidc.client_id));
    box.appendChild(secretOnce(host, out.oidc.client_id, out.oidc.client_secret));
    var dc = domainCard(body.slug);
    if (out.provision) {
      if (out.provision.state === "created")
        dc.out.style.color = "var(--ok)", dc.out.textContent = "✔ 已自动注册（创建租户时）";
      else if (out.provision.state === "already")
        dc.out.style.color = "var(--ok)", dc.out.textContent = "✔ 已在本服务名下";
      else if (out.provision.state === "disabled")
        dc.out.style.color = "var(--cf)", dc.out.textContent = "· 未配置自动开通 API —— 跑一次 bash deploy.sh 配置（会引导建 Token）；其间可用下方按钮";
      else
        dc.out.style.color = "var(--danger)", dc.out.textContent = "✘ " + (out.provision.detail || "自动开通失败");
    }
    box.appendChild(dc.card);
    box.appendChild(notice("保存后回到 Cloudflare 的登录方法上点「测试」扫码；打不开租户域名先点上面「检测」。", "cf"));
    toast("租户已创建");
    loadTenants();
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }).catch(function(e){
    pre.textContent = "创建失败: " + e.message; pre.classList.remove("hide");
  });
});

function loadTenants(){
  api("/tenants").then(function(d){
    var tb = $("tbody"); tb.textContent = "";
    if (!d.tenants.length) {
      var tr = document.createElement("tr");
      var td = document.createElement("td"); td.colSpan = 4; td.className = "hint";
      td.textContent = "还没有租户";
      tr.appendChild(td); tb.appendChild(tr); return;
    }
    d.tenants.forEach(function(t){
      var tr = document.createElement("tr");
      tr.appendChild(el("td", null, t.slug));
      var st = el("td"); var bd = el("span", "badge" + (t.status === "active" ? "" : " off"), t.status);
      st.appendChild(bd); tr.appendChild(st);
      var cid = el("td"); var cc = el("code", null, t.clientId || "-"); cid.appendChild(cc); tr.appendChild(cid);
      var act = el("td"); act.className = "acts";
      var addBtn = function(label, cls, fn){
        var b = el("button", "sec sm" + (cls ? " " + cls : ""), label);
        b.addEventListener("click", fn); act.appendChild(b);
      };
      addBtn("详情", "", function(){ showDetail(t.slug); });
      addBtn("查看 Secret", "", function(){ showSecret(t.slug); });
      addBtn("日志", "", function(){ showLogs(t.slug); });
      addBtn(t.status === "active" ? "停用" : "启用", t.status === "active" ? "warn" : "",
        function(){ setStatus(t.slug, t.status === "active" ? "disabled" : "active"); });
      tr.appendChild(act);
      tb.appendChild(tr);
    });
  }).catch(function(e){
    var m = (e.message || "").toLowerCase();
    if (m.indexOf("unauthorized") >= 0) toast("token 不对或没填 —— 先在上方连接");
    else toast("加载失败: " + e.message);
  });
}
function setStatus(slug, status){
  api("/tenants/" + slug, { method: "PATCH", body: JSON.stringify({ status: status }) })
    .then(function(){ toast(slug + " → " + status); loadTenants(); showDetail(slug); })
    .catch(function(e){ toast("失败: " + e.message); });
}
function showSecret(slug){
  api("/tenants/" + slug + "/client-secret").then(function(r){
    var box = $("detail"); box.classList.remove("hide"); box.textContent = "";
    box.appendChild(el("h2", null, "Client Secret · " + slug));
    var c = card("查看 Secret（加密存储，按需解密）", "cf");
    c.appendChild(fieldRow("Client Secret", r.client_secret));
    c.appendChild(el("p", "hint", "只交给客户配 CF Access 用；怀疑泄露就「重置 Client Secret」。"));
    box.appendChild(c);
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }).catch(function(e){ toast("取 Secret 失败: " + e.message); });
}
function showDetail(slug){
  api("/tenants/" + slug).then(function(t){
    var host = t.slug + "." + BASE;
    var box = $("detail"); box.classList.remove("hide"); box.textContent = "";
    box.appendChild(el("h2", null, "详情 · " + t.slug));
    box.appendChild(dingCard(host, t.dtClientId, t.corpIds, t.emailMode));
    box.appendChild(cfCard(host, t.clientId));
    var dc = domainCard(t.slug);
    box.appendChild(dc.card);
    var meta = card("配置与运维");
    var line = function(k, v){
      var p = el("p", null); p.style.margin = ".3rem 0"; p.style.fontSize = ".87rem";
      p.appendChild(el("b", null, k + "：")); p.appendChild(document.createTextNode(v));
      meta.appendChild(p);
    };
    line("状态", t.status);
    line("允许的回调", t.redirects.join("，") + (t.anyRedirect ? "（任意回调域：开）" : ""));
    var acts = el("div", "acts");
    var mkBtn = function(label, cls, fn){
      var b = el("button", "sec sm" + (cls ? " " + cls : ""), label);
      b.addEventListener("click", fn); acts.appendChild(b);
    };
    mkBtn("查看 Secret", "", function(){ showSecret(slug); });
    mkBtn("轮换签名密钥", "", function(){
      api("/tenants/" + slug + "/rotate-key", { method: "POST" })
        .then(function(r){ toast("已轮换 kid=" + r.newKid); })
        .catch(function(e){ toast("失败: " + e.message); });
    });
    mkBtn("重置 Client Secret", "warn", function(){
      api("/tenants/" + slug + "/rotate-client-secret", { method: "POST" })
        .then(function(r){
          var c2 = card("新 Client Secret（旧的可继续「查看」前已被覆盖）", "cf");
          c2.appendChild(fieldRow("新 Client Secret", r.client_secret));
          box.insertBefore(c2, meta);
        })
        .catch(function(e){ toast("失败: " + e.message); });
    });
    mkBtn(t.status === "active" ? "停用租户" : "启用租户", t.status === "active" ? "warn" : "",
      function(){ setStatus(slug, t.status === "active" ? "disabled" : "active"); });
    meta.appendChild(acts);
    box.appendChild(meta);
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }).catch(function(e){ toast("加载详情失败: " + e.message); });
}
function showLogs(slug){
  api("/tenants/" + slug + "/logs?limit=50").then(function(d){
    var box = $("logs"); box.classList.remove("hide"); box.textContent = "";
    box.appendChild(el("h2", null, "登录审计 · " + slug));
    var card1 = el("div", "card"); card1.style.padding = ".4rem .9rem";
    var tb = document.createElement("table");
    var thead = document.createElement("thead");
    thead.innerHTML = "<tr><th>时间</th><th>union_id</th><th>动作</th><th>详情</th></tr>";
    tb.appendChild(thead);
    var tbody = document.createElement("tbody");
    (d.logs || []).forEach(function(l){
      var tr = document.createElement("tr");
      [new Date(l.ts).toLocaleString(), l.union_id, l.action, l.detail || ""].forEach(function(v){
        tr.appendChild(el("td", null, v));
      });
      tbody.appendChild(tr);
    });
    if (!d.logs || !d.logs.length) {
      var tr = document.createElement("tr");
      tr.appendChild(el("td", "hint", "暂无记录")).colSpan = 4;
      tbody.appendChild(tr);
    }
    tb.appendChild(tbody); card1.appendChild(tb); box.appendChild(card1);
    box.scrollIntoView({ behavior: "smooth", block: "start" });
  }).catch(function(e){ toast("加载日志失败: " + e.message); });
}
var saved = localStorage.getItem("adminToken");
if (saved) { $("token").value = saved; loadTenants(); }
</script>
</body>
</html>`;
}
