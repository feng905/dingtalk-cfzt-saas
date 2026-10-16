/**
 * docs.js — 客户接入文档（/docs）：markdown 进 Worker 包，按租户 Host 替换真实值
 *
 * 从租户地址（https://<slug>.sso.<主域>/docs）打开 → 填入该租户的回调地址、
 * OIDC 三 URL 与 Client ID；从管理入口（deploy-check，无租户）打开 → 显示
 * acme.sso.example.com 形式的示例值。绝不输出 client_secret。
 * 渲染在浏览器端完成（public/docs/marked.min.js，同源静态文件）。
 */

import indexMd from "../docs/README.md";
import dingtalkMd from "../docs/1-dingtalk-app.md";
import cfAccessMd from "../docs/2-cloudflare-access.md";
import troubleMd from "../docs/3-troubleshooting.md";
import { tenantSlugFromRequest, getTenant } from "./tenant.js";

const PAGES = [
  { id: "README", title: "接入总览", md: indexMd },
  { id: "1-dingtalk-app", title: "① 钉钉建应用", md: dingtalkMd },
  { id: "2-cloudflare-access", title: "② CF Zero Trust 配置", md: cfAccessMd },
  { id: "3-troubleshooting", title: "③ 排错对照表", md: troubleMd },
];

/* 无租户上下文时的示例值（与文档行文约定一致：acme.sso.example.com） */
const GENERIC = {
  tenantHost: "acme.sso.example.com",
  callbackUrl: "https://acme.sso.example.com/cb",
  authUrl: "https://acme.sso.example.com/authorize",
  tokenUrl: "https://acme.sso.example.com/token",
  jwksUrl: "https://acme.sso.example.com/jwks",
  clientId: "运营给你的 client_id",
  real: false,
};

function pageById(id) {
  return PAGES.find((p) => p.id === id) || null;
}

function fillTokens(md, v) {
  return md
    .split("{{TENANT_HOST}}").join(v.tenantHost)
    .split("{{CALLBACK_URL}}").join(v.callbackUrl)
    .split("{{AUTH_URL}}").join(v.authUrl)
    .split("{{TOKEN_URL}}").join(v.tokenUrl)
    .split("{{JWKS_URL}}").join(v.jwksUrl)
    .split("{{CLIENT_ID}}").join(v.clientId);
}

/* ---------------- 文档外壳页（导航 + 浏览器端 marked 渲染） ---------------- */

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function shellHtml(page, vals, filledMd) {
  const nav = PAGES.map((p) =>
    `<a href="/docs/${p.id}"${p.id === page.id ? ' class="cur"' : ""}>${esc(p.title)}</a>`,
  ).join("");
  const banner = vals.real
    ? `<div class="banner ok">✓ 已按你的租户自动填入真实值：<b>${esc(vals.tenantHost)}</b>${vals.clientId && !vals.clientId.startsWith("运营") ? ` · Client ID：<code>${esc(vals.clientId)}</code>` : ""}</div>`
    : `<div class="banner">当前显示的是<b>示例值</b>。从你的租户地址打开本文档（<code>https://你的租户地址/docs</code>），回调地址、OIDC URL 和 Client ID 会自动换成你的真实值。</div>`;
  // 嵌入文档文本（</script> 防闭合）
  const payload = JSON.stringify({ id: page.id, md: filledMd }).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(page.title)} · 接入文档</title>
<style>
:root { --fg:#1f2328; --muted:#656d76; --line:#d8dee4; --bg:#fff; --soft:#f6f8fa; --accent:#0969da; --okbg:#dafbe1; --okfg:#116329; }
* { box-sizing: border-box; }
body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif; }
header { border-bottom:1px solid var(--line); background:var(--soft); }
.wrap { max-width:860px; margin:0 auto; padding:0 16px; }
nav { display:flex; flex-wrap:wrap; gap:4px; padding:10px 0; }
nav a { color:var(--muted); text-decoration:none; padding:6px 12px; border-radius:6px; font-size:.92rem; white-space:nowrap; }
nav a:hover { background:#eaeef2; color:var(--fg); }
nav a.cur { background:var(--accent); color:#fff; }
.banner { margin:16px 0 0; padding:10px 14px; border:1px solid var(--line); border-radius:8px; font-size:.9rem; color:var(--muted); }
.banner.ok { background:var(--okbg); color:var(--okfg); border-color:transparent; }
.banner code { background:rgba(255,255,255,.7); padding:1px 6px; border-radius:4px; }
main { padding:8px 0 64px; }
.md h1 { font-size:1.5rem; border-bottom:1px solid var(--line); padding-bottom:.4em; }
.md h2 { font-size:1.22rem; border-bottom:1px solid var(--line); padding-bottom:.3em; margin-top:2em; }
.md code { background:var(--soft); border:1px solid var(--line); border-radius:4px; padding:.15em .4em; font-size:.88em; word-break:break-all; }
.md pre { background:var(--soft); border:1px solid var(--line); border-radius:8px; padding:12px 14px; overflow-x:auto; }
.md pre code { background:none; border:none; padding:0; font-size:.85rem; }
.md table { border-collapse:collapse; width:100%; margin:1em 0; display:block; overflow-x:auto; }
.md th,.md td { border:1px solid var(--line); padding:7px 11px; text-align:left; font-size:.92rem; }
.md th { background:var(--soft); }
.md tr:nth-child(2n) td { background:var(--soft); }
.md blockquote { margin:1em 0; padding:.2em 1em; border-left:4px solid var(--line); color:var(--muted); }
.md a { color:var(--accent); }
.md img { max-width:100%; }
footer { border-top:1px solid var(--line); color:var(--muted); font-size:.82rem; padding:16px; text-align:center; }
</style>
</head>
<body>
<header><div class="wrap"><nav>${nav}</nav></div></header>
<div class="wrap">
${banner}
<main><div class="md" id="doc">文档加载中…</div></main>
</div>
<footer>钉钉登录 Cloudflare Zero Trust · 接入文档</footer>
<script src="/docs/marked.min.js"></script>
<script>
window.__DOC__ = ${payload};
(function(){
  try {
    document.getElementById("doc").innerHTML = marked.parse(window.__DOC__.md);
  } catch (e) {
    document.getElementById("doc").textContent = "渲染失败，原文如下：\\n\\n" + window.__DOC__.md;
  }
})();
</script>
</body>
</html>`;
}

/* ---------------- 路由入口（index.js 在租户 OIDC 面之前调用） ---------------- */

export async function handleDocs(request, env, path) {
  // path 已去掉尾斜杠；/docs → README；/docs/<page>.md → 纯 markdown（调试/抓取用）
  const mdMatch = path.match(/^\/docs\/([A-Za-z0-9-]+)\.md$/);
  const htmlMatch = path.match(/^\/docs(?:\/([A-Za-z0-9-]+))?$/);
  const page = pageById(mdMatch ? mdMatch[1] : (htmlMatch && htmlMatch[1]) || "README");
  if (!page) {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  // 租户上下文：Host 是有效且 active 的租户才填真实值
  const vals = { ...GENERIC };
  const slug = tenantSlugFromRequest(request, env);
  if (slug) {
    const tenant = await getTenant(env, slug).catch(() => null);
    if (tenant && tenant.status === "active") {
      const host = `${slug}.${env.SSO_BASE_DOMAIN}`;
      const client = await env.DB.prepare(
        "SELECT client_id FROM oidc_clients WHERE tenant_slug = ? AND status = 'active'",
      ).bind(slug).first();
      vals.tenantHost = host;
      vals.callbackUrl = `https://${host}/cb`;
      vals.authUrl = `https://${host}/authorize`;
      vals.tokenUrl = `https://${host}/token`;
      vals.jwksUrl = `https://${host}/jwks`;
      vals.clientId = client ? client.client_id : "（暂无，请联系运营）";
      vals.real = true;
    }
  }

  const filled = fillTokens(page.md, vals);
  if (mdMatch) {
    return new Response(filled, {
      headers: { "Content-Type": "text/markdown; charset=utf-8" },
    });
  }
  return new Response(shellHtml(page, vals, filled), {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
