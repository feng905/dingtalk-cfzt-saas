/**
 * admin.js — 租户管理 API（Bearer ADMIN_TOKEN）+ 最简 HTML 控制台
 *
 * POST   /admin/tenants                     建租户（返回 client_id/secret，secret 只显示一次）
 * GET    /admin/tenants                     列表
 * GET    /admin/tenants/:slug               详情
 * PATCH  /admin/tenants/:slug               改配置（corpIds/redirects/emailMode/status/anyRedirect）
 * DELETE /admin/tenants/:slug               停用（软删）
 * POST   /admin/tenants/:slug/rotate-key    轮换签名密钥（旧 key 转 retiring，仍可验签）
 * POST   /admin/tenants/:slug/rotate-client-secret  重置 OIDC client secret
 * GET    /admin/tenants/:slug/logs?limit=50 登录审计
 * GET    /admin/                            HTML 控制台
 */

import {
  randomHex, sha256Hex, safeEq, generateRsaKey, aesEncrypt,
} from "./core.js";
import { isValidCfRedirect } from "./tenant.js";

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
        "INSERT INTO oidc_clients (client_id, tenant_slug, secret_hash, status, created_at) VALUES (?, ?, ?, 'active', ?)",
      ).bind(clientId, slug, await sha256Hex(clientSecret), now),
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

  return json({
    slug,
    // client_secret 只此一次明文展示
    oidc: {
      issuer: `https://${slug}.${env.SSO_BASE_DOMAIN}`,
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
    `SELECT t.slug, t.status, t.corp_ids, t.allowed_redirects, t.any_redirect, t.email_mode, t.created_at, t.updated_at, c.client_id
     FROM tenants t LEFT JOIN oidc_clients c ON c.tenant_slug = t.slug AND c.status = 'active'
     WHERE t.slug = ?`,
  ).bind(slug).first();
  if (!row) return err("tenant not found", 404);
  return json({
    slug: row.slug,
    status: row.status,
    corpIds: JSON.parse(row.corp_ids),
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
    "UPDATE oidc_clients SET secret_hash = ? WHERE tenant_slug = ? AND status = 'active'",
  ).bind(await sha256Hex(newSecret), slug).run();
  if (!r.meta || r.meta.changes === 0) return err("no active client for tenant", 404);
  return json({ slug, client_secret: newSecret }, 201);
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
  if (!checkAuth(request, env)) return err("unauthorized", 401);

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/admin";
  const m = path.match(/^\/admin\/tenants\/([a-z0-9-]+)(\/.*)?$/);

  try {
    if (path === "/admin" || path === "/admin/") {
      return new Response(adminHtml(), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }
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
      if (sub === "/logs" && request.method === "GET") return await tenantLogs(request, env, slug);
    }
    return err("not found", 404);
  } catch (e) {
    return err(String(e), 500);
  }
}

/* ---------------- HTML 控制台（不求好看，能用） ---------------- */

function adminHtml() {
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>DingTalk-CFZT SaaS 控制台</title>
<style>
  body{font-family:ui-sans-serif,system-ui;max-width:860px;margin:2rem auto;padding:0 1rem;color:#1a1a2e}
  h1{font-size:1.3rem} h2{font-size:1.05rem;margin-top:2rem}
  label{display:block;margin:.5rem 0 .2rem;font-size:.85rem;color:#555}
  input,textarea{width:100%;box-sizing:border-box;padding:.45rem;border:1px solid #ccc;border-radius:6px;font-size:.9rem}
  button{margin-top:.8rem;padding:.5rem 1.2rem;border:0;border-radius:6px;background:#2563eb;color:#fff;cursor:pointer}
  button.sec{background:#666}
  pre{background:#f4f4f6;padding:.8rem;border-radius:8px;overflow:auto;font-size:.78rem;white-space:pre-wrap}
  table{width:100%;border-collapse:collapse;font-size:.85rem}
  th,td{padding:.4rem;border-bottom:1px solid #eee;text-align:left}
  .warn{color:#b45309;font-size:.8rem}
</style>
</head>
<body>
<h1>钉钉 → Cloudflare ZT SaaS 控制台</h1>
<p class="warn">Access Token 只保存在本浏览器（localStorage）。创建租户返回的 client_secret 只显示一次，请立即复制。</p>
<label>Admin Token</label>
<input id="token" type="password" placeholder="ADMIN_TOKEN">
<button class="sec" onclick="loadTenants()">加载租户列表</button>

<h2>创建租户</h2>
<label>slug（子域名前缀，如 acme → acme.sso.example.com）</label>
<input id="f-slug" placeholder="acme">
<label>钉钉 AppKey（dtClientId）</label>
<input id="f-dtid">
<label>钉钉 AppSecret（dtClientSecret）</label>
<input id="f-dtsec" type="password">
<label>允许的 corpId（JSON 数组，["*"]=不限）</label>
<input id="f-corp" value='["*"]'>
<label>redirect_uri 白名单（JSON 数组）</label>
<input id="f-redirects" value='["https://REPLACE-team.cloudflareaccess.com/cdn-cgi/access/callback"]'>
<label>emailMode</label>
<select id="f-email"><option>synthetic</option><option>prefer_real</option></select>
<button onclick="createTenant()">创建</button>
<pre id="create-out"></pre>

<h2>租户列表</h2>
<table id="tenants"><thead><tr><th>slug</th><th>状态</th><th>client_id</th><th>操作</th></tr></thead><tbody></tbody></table>
<pre id="detail-out"></pre>

<script>
const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const resp = await fetch('/admin' + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + $('token').value },
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error(JSON.stringify(data));
  return data;
};
window.loadTenants = async () => {
  try {
    localStorage.setItem('adminToken', $('token').value);
    const { tenants } = await api('/tenants');
    const tb = $('tenants').querySelector('tbody');
    tb.innerHTML = '';
    for (const t of tenants) {
      const tr = document.createElement('tr');
      tr.innerHTML = '<td>' + t.slug + '</td><td>' + t.status + '</td><td><code>' + (t.clientId||'-') + '</code></td>' +
        '<td><button class="sec" onclick="detail(\\'' + t.slug + '\\')">详情</button> ' +
        '<button class="sec" onclick="rotateKey(\\'' + t.slug + '\\')">轮换密钥</button> ' +
        '<button class="sec" onclick="logs(\\'' + t.slug + '\\')">日志</button></td>';
      tb.appendChild(tr);
    }
  } catch (e) { alert('加载失败: ' + e.message); }
};
window.createTenant = async () => {
  try {
    const body = {
      slug: $('f-slug').value.trim(),
      dtClientId: $('f-dtid').value.trim(),
      dtClientSecret: $('f-dtsec').value,
      corpIds: JSON.parse($('f-corp').value),
      redirects: JSON.parse($('f-redirects').value),
      emailMode: $('f-email').value,
    };
    const out = await api('/tenants', { method: 'POST', body: JSON.stringify(body) });
    $('create-out').textContent = JSON.stringify(out, null, 2);
    loadTenants();
  } catch (e) { $('create-out').textContent = '创建失败: ' + e.message; }
};
window.detail = async (slug) => { $('detail-out').textContent = JSON.stringify(await api('/tenants/' + slug), null, 2); };
window.rotateKey = async (slug) => { if (confirm('轮换 ' + slug + ' 的签名密钥？')) $('detail-out').textContent = JSON.stringify(await api('/tenants/' + slug + '/rotate-key', { method: 'POST' }), null, 2); };
window.logs = async (slug) => { $('detail-out').textContent = JSON.stringify(await api('/tenants/' + slug + '/logs?limit=20'), null, 2); };
const saved = localStorage.getItem('adminToken'); if (saved) $('token').value = saved;
</script>
</body>
</html>`;
}
