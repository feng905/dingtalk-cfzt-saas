/**
 * mock-dingtalk.js — 本地钉钉协议模拟器（e2e 用）
 *
 * 模拟三个端点：
 *   GET  /oauth2/auth                    授权页（直接当作用户已扫码，302 回调带 authCode）
 *   POST /v1.0/oauth2/userAccessToken    JSON camelCase 校验 + authCode 一次性
 *   GET  /v1.0/contact/users/me          x-acs-dingtalk-access-token 头校验
 *
 * 内置两个应用（用于 corpId 拒绝测试）：
 *   dt-mock-id   / dt-mock-secret    → corpId: ding-corp-ok
 *   dt-mock-b    / dt-mock-secret-b  → corpId: ding-corp-other
 */

import http from "node:http";

const PORT = 9901;
const APPS = {
  "dt-mock-id": { secret: "dt-mock-secret", corpId: "ding-corp-ok" },
  "dt-mock-b": { secret: "dt-mock-secret-b", corpId: "ding-corp-other" },
};
const USER = { nick: "张三", unionId: "u-mock-123", openId: "o-mock", email: "", avatarUrl: "", stateCode: "86" };

const codes = new Map(); // authCode -> {clientId, used}
let seq = 0;

function send(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...headers });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // 授权端点：省略扫码，直接签发 authCode 并回调
  if (url.pathname === "/oauth2/auth" && req.method === "GET") {
    const clientId = url.searchParams.get("client_id");
    const redirectUri = url.searchParams.get("redirect_uri");
    const state = url.searchParams.get("state") || "";
    if (!APPS[clientId]) return send(res, 400, { error: "unknown mock client_id" });
    const authCode = `mockcode-${++seq}-${Date.now()}`;
    codes.set(authCode, { clientId, used: false });
    const back = new URL(redirectUri);
    back.searchParams.set("authCode", authCode);
    back.searchParams.set("state", state);
    res.writeHead(302, { Location: back.toString() });
    return res.end();
  }

  // token 端点：必须 JSON camelCase（验证协议翻译层）
  if (url.pathname === "/v1.0/oauth2/userAccessToken" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { code: "InvalidParameter", message: "body must be JSON" });
      }
      const { clientId, clientSecret, code, grantType } = body;
      const app = APPS[clientId];
      if (!app || app.secret !== clientSecret) {
        return send(res, 400, { code: "InvalidAuthentication", message: "不合法的参数 client_secret" });
      }
      if (grantType !== "authorization_code") {
        return send(res, 400, { code: "InvalidGrantType", message: "不支持的 grantType" });
      }
      const entry = codes.get(code);
      if (!entry || entry.used || entry.clientId !== clientId) {
        return send(res, 400, { code: "InvalidParameter.authCode.notFound", message: "不合法的临时授权码" });
      }
      entry.used = true;
      send(res, 200, {
        accessToken: `mock-at-${clientId}`,
        refreshToken: "mock-rt",
        expireIn: 7200,
        corpId: app.corpId,
      });
    });
    return;
  }

  // profile 端点：必须 x-acs 头（验证协议翻译层）
  if (url.pathname === "/v1.0/contact/users/me" && req.method === "GET") {
    const token = req.headers["x-acs-dingtalk-access-token"];
    if (!token || !token.startsWith("mock-at-")) {
      return send(res, 400, { code: "MissingParameter", message: "缺少参数：x-acs-dingtalk-access-token" });
    }
    return send(res, 200, USER);
  }

  send(res, 404, { error: "mock: not found" });
});

server.listen(PORT, "127.0.0.1", () => console.log(`mock dingtalk on http://127.0.0.1:${PORT}`));
