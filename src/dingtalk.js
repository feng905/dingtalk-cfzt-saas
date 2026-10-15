/**
 * dingtalk.js — 钉钉私有协议客户端（非标 OAuth2 的三个坑都在这）
 *  1. token 端点只收 JSON camelCase
 *  2. profile 要 x-acs-dingtalk-access-token 头
 *  3. 回调只带 authCode（对 worker 来说无所谓，我们自产自销）
 */

async function postJson(url, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return resp.json().catch(() => ({}));
}

/** 授权码换用户 access token；失败时返回 {code, message} 形态的错误 */
export async function dtExchangeCode(env, { clientId, clientSecret, code }) {
  const base = env.DT_API_BASE || "https://api.dingtalk.com";
  return postJson(`${base}/v1.0/oauth2/userAccessToken`, {
    clientId,
    clientSecret,
    grantType: "authorization_code",
    code,
  });
}

/** 拉用户信息（unionId/nick/email/mobile/avatarUrl/stateCode 等） */
export async function dtProfile(env, accessToken) {
  const base = env.DT_API_BASE || "https://api.dingtalk.com";
  const resp = await fetch(`${base}/v1.0/contact/users/me`, {
    method: "GET",
    headers: { "x-acs-dingtalk-access-token": accessToken },
  });
  return resp.json().catch(() => ({}));
}

/**
 * 钉钉用户数据 → OIDC claims。
 * emailMode:
 *   synthetic   — 永远用 unionId@dingtalk.local（默认；避免真实邮箱与 CF 策略漂移）
 *   prefer_real — 有真实邮箱用真实，否则合成（与老版单租户 worker 行为一致）
 */
export function toOidcClaims(dtData, emailMode) {
  const unionId = dtData.unionId;
  const rawEmail = dtData.email || null;
  const synthetic = `${unionId}@dingtalk.local`;
  const email = emailMode === "prefer_real" ? rawEmail || synthetic : synthetic;
  return {
    sub: unionId,
    name: dtData.nick || null,
    nickname: dtData.nick || null,
    preferred_username: email,
    email,
    email_verified: true,
    picture: dtData.avatarUrl || null,
    dingtalk: {
      unionId,
      openId: dtData.openId || null,
      stateCode: dtData.stateCode || null,
    },
  };
}
