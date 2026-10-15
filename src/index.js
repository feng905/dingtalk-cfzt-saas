/**
 * index.js — 路由入口
 *   /health                    健康检查
 *   /admin/*                   管理面（Bearer ADMIN_TOKEN）
 *   其余                       租户 OIDC 端点（Host 决定租户）
 */

import { handleAdmin } from "./admin.js";
import {
  handleDiscovery, handleAuthorize, handleCallback, handleToken, handleUserinfo, handleJwks,
} from "./oidc.js";
import { tenantSlugFromRequest } from "./tenant.js";

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";

    try {
      if (path === "/health") return json({ ok: true, ts: Date.now() });
      if (path === "/admin" || path.startsWith("/admin/")) return await handleAdmin(request, env);

      // 租户 OIDC 面：无有效租户 host 一律 404
      const slug = tenantSlugFromRequest(request, env);
      if (!slug) return json({ error: "not_found", error_description: "unknown tenant host" }, 404);

      switch (path) {
        case "/.well-known/openid-configuration":
          return handleDiscovery(request);
        case "/authorize":
          return await handleAuthorize(request, env);
        case "/cb":
          return await handleCallback(request, env);
        case "/token":
          return await handleToken(request, env);
        case "/userinfo":
          return await handleUserinfo(request, env, slug);
        case "/jwks":
          return await handleJwks(env, slug);
        default:
          return json({ error: "not_found" }, 404);
      }
    } catch (err) {
      console.log("saas error:", String(err));
      return json({ error: "internal_error", error_description: String(err) }, 500);
    }
  },
};
