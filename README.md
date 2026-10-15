# dingtalk-cfzt-saas

钉钉登录 Cloudflare Zero Trust 的多租户 SaaS — Worker 直接当 OIDC IdP，客户把 CF Access 的 OIDC 登录方式指到自己的 `https://<slug>.sso.<域名>` 即可。

架构与决策记录见 `~/Documents/notes/dingtalk-saas-roadmap.md`；协议层为什么这么写（钉钉三个非标坑）见同目录架构文档。

## 结构

```
src/
  index.js     路由入口（/health /admin/* 租户 OIDC 面）
  core.js      WebCrypto 原语：HMAC state/code、AES-GCM 字段加密、RSA 密钥、RS256 JWT
  dingtalk.js  钉钉私有协议客户端（JSON camelCase / x-acs 头 / corpId）
  tenant.js    Host→租户解析、D1 配置访问、密钥缓存、CF 回调形态校验
  oidc.js      discovery /authorize /cb /token /userinfo /jwks
  admin.js     管理 API + 最简 HTML 控制台（/admin/）
schema.sql     D1 表（tenants / oidc_clients / signing_keys / used_jti / audit_log）
test/
  mock-dingtalk.js  钉钉协议模拟器（两个 mock 应用，用于 corpId 拒绝测试）
  e2e.sh            27 项断言的本地全链路测试
```

安全设计：租户凭证 AES-GCM 落库（KEK=ENCRYPTION_KEY）、每租户独立 RSA 密钥对、OIDC client secret 只存哈希、
code 一次性（D1 jti 去重防重放）、corpId 白名单准入、redirect_uri 限定 `*.cloudflareaccess.com/cdn-cgi/access/callback`、
审计只记 unionId 不落个人信息（PIPL）。

## 本地开发 / e2e

```bash
node -e "const c=require('crypto');const h=n=>c.randomBytes(n).toString('hex');  \
  require('fs').writeFileSync('.dev.vars',                                      \
  ['ENCRYPTION_KEY='+h(32),'STATE_SECRET='+h(32),'ADMIN_TOKEN='+h(24),          \
   'DT_API_BASE=http://127.0.0.1:9901','DT_LOGIN_BASE=http://127.0.0.1:9901',   \
   'SSO_BASE_DOMAIN=sso.example.com','DEV_TENANT=demo',''].join('\n'))"
npm run e2e     # 起 mock 钉钉 + wrangler dev，跑全部 27 项断言
```

## 生产部署清单（首次）

1. `SSO_BASE_DOMAIN` 改成真实域名，`wrangler.toml` 加通配符自定义域：
   `routes = [{ pattern = "*.sso.<域名>", custom_domain = true }]`
2. `wrangler d1 create dingtalk-saas` → 把 `database_id` 填进 `wrangler.toml`
3. `wrangler d1 execute DB --remote --file=schema.sql`
4. `wrangler secret put ENCRYPTION_KEY`（32 字节 hex）/ `STATE_SECRET` / `ADMIN_TOKEN`
5. `wrangler deploy`，浏览器打开 `https://<管理域名>/admin/` 或用 API 建租户

> 管理面当前只挡 ADMIN_TOKEN；上生产建议在 CF 侧再给 `/admin/*` 套一层 Access 自保护。

## 管理 API

```bash
T="Authorization: Bearer $ADMIN_TOKEN"
# 建租户（返回的 client_secret 只显示一次，直接给客户配 CF Access）
curl -X POST https://admin host/admin/tenants -H "$T" -H "Content-Type: application/json" -d '{
  "slug": "acme",
  "corpIds": ["dingxxxxxxxxxxxxxxxx"],          # 客户钉钉组织的 corpId，["*"]=不限
  "dtClientId": "<客户钉钉应用 AppKey>",
  "dtClientSecret": "<AppSecret>",
  "redirects": ["https://acme-team.cloudflareaccess.com/cdn-cgi/access/callback"]
}'
curl -s -H "$T" .../admin/tenants               # 列表
curl -s -H "$T" .../admin/tenants/acme          # 详情
curl -X PATCH -H "$T" -d '{"status":"disabled"}' .../admin/tenants/acme   # 停用
curl -X POST -H "$T" .../admin/tenants/acme/rotate-key                    # 轮换签名密钥
curl -s -H "$T" .../admin/tenants/acme/logs?limit=50                      # 登录审计
```

## 客户接入流程（BYO）

1. 客户在[钉钉开放平台](https://open.dingtalk.com)建企业内部应用，开通「个人信息读取」权限，
   回调地址填 `https://<slug>.sso.<域名>/cb`
2. 把 AppKey/AppSecret + 自己的 CF 团队回调地址交给运营（或自助控制台）建租户
3. 拿到 `client_id`/`client_secret`，在 CF ZT → Integrations → Identity providers → OpenID Connect 填五项：
   Client ID / Client Secret / Auth URL=`https://<slug>.sso.<域名>/authorize` /
   Token URL=`.../token` / Certificate URL=`.../jwks`（PKCE 不开）
4. 点 IdP 旁 Test 按钮真实扫码验证 → Access 应用勾选该登录方式
