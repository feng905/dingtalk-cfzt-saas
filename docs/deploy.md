# 生产部署手册

服务部署在 Cloudflare Workers 上，占用域名 **`*.sso.eastasia-gcr-nfr.cftenant.com`** 子树。
本文档是完整部署步骤：推荐用一键脚本 `deploy.sh`（交互式确认），也给出等价的手工命令。

```
┌─ Cloudflare 账号（eastasia-gcr-nfr.cftenant.com zone）────────────────┐
│                                                                       │
│  sso-dingtalk-proxy.eastasia-gcr-nfr.cftenant.com   ← 老 Worker，不动  │
│                                                                       │
│  *.sso.eastasia-gcr-nfr.cftenant.com                ← 本次部署占用     │
│    ├─ acme.sso.…          每租户一个三级子域 = 该租户的 OIDC issuer    │
│    ├─ deploy-check.sso.…  部署验证用（也可当管理控制台入口）           │
│    └─ <任何slug>.sso.…                                                │
│                                                                       │
│  Worker: dingtalk-cfzt-saas（含落地页 public/index.html）             │
│  D1:     dingtalk-saas（tenants / oidc_clients / signing_keys /       │
│          used_jti / audit_log）                                       │
└───────────────────────────────────────────────────────────────────────┘
```

## 隔离保证（为什么不会影响其他域名）

1. **子树零重叠**：通配符 `*.sso.eastasia-gcr-nfr.cftenant.com` 只匹配「恰好多一层 `.sso.`」的主机名
   （`acme.sso.…`）。现有 `sso-dingtalk-proxy.eastasia-gcr-nfr.cftenant.com` 不在该子树内，
   不是通配符更不更具体的问题——结构上就匹配不到。
2. **部署按 Worker 隔离**：`wrangler deploy` 只上传/变更 `wrangler.toml` 里 `name` 指定的这一个 Worker，
   老 Worker `sso-dingtalk-proxy` 的代码、Secrets、自定义域都不会被触碰。
3. **脚本前后回归比对**：`deploy.sh` 部署前记录老 Worker 的基线（`/health` 200、`/auth` 302），
   部署后重新探测比对，任何回归都会明确报出来。

## 前置条件

- 本机已装 wrangler（`npm i -g wrangler`）并已登录：`npx wrangler login`
  （登录账号要能操作 `eastasia-gcr-nfr.cftenant.com` 所在的 Cloudflare 账号）
- `python3`、`curl`、`openssl`（macOS 自带）
- 在仓库根目录运行（`deploy.sh` 自己也会 cd 过去）

## 一键部署（推荐）

```bash
bash deploy.sh --dry-run   # 先预演：只读检查环境、展示计划，不做任何变更
bash deploy.sh             # 正式部署
```

脚本全程交互，每一步都会确认；随时 Ctrl+C 退出。各阶段会问什么：

| 阶段 | 交互 | 脚本做什么 |
|---|---|---|
| 预检 | 确认部署计划 | wrangler 登录检查；记录老 Worker 基线；展示将占用/不触碰的域名 |
| 1 D1 | 确认建库 | `wrangler d1 list` 查重 → 不存在则 `d1 create`，`database_id` 自动写回 `wrangler.toml` |
| 2 建表 | 确认执行 | `d1 execute --remote --file=schema.sql`（全部 `IF NOT EXISTS`，可重复跑） |
| 3 Secrets | 展示一次 + 确认写入 | 生成 ENCRYPTION_KEY / STATE_SECRET / ADMIN_TOKEN，备份到 `.secrets/production/`（已 gitignore），逐个 `wrangler secret put`；已存在的默认保留 |
| 4 部署 | 最终确认 | `wrangler deploy`（创建通配符自定义域，证书自动签发） |
| 5 验证 | 无（自动） | 新域名 /health、discovery issuer、/admin 401；老 Worker 两项回归比对 |
| 附加 | 可跳过 | 可选：现场创建第一个租户，打印 client_id/secret 和 CF Access 五字段 |

Secrets 只在生成时展示一次，之后保存在 `.secrets/production/`（权限 600），脚本不会回显。

## 手工分步部署（与脚本等价）

```bash
# 0. 预检
npx wrangler whoami

# 1. D1 建库，把输出的 database_id 填进 wrangler.toml
npx wrangler d1 create dingtalk-saas
#   编辑 wrangler.toml → database_id = "<输出的id>"

# 2. 远程建表（幂等）
npx wrangler d1 execute DB --remote --file=schema.sql -y

# 3. 生产 Secrets（各生成一次，妥善保存；必须全新生成，勿复用单租户 Worker 的）
openssl rand -hex 32   # → ENCRYPTION_KEY
openssl rand -hex 32   # → STATE_SECRET
openssl rand -hex 24   # → ADMIN_TOKEN
npx wrangler secret put ENCRYPTION_KEY     # 回车后粘贴值
npx wrangler secret put STATE_SECRET
npx wrangler secret put ADMIN_TOKEN

# 4. 部署
npx wrangler deploy

# 5. 验证
curl https://deploy-check.sso.eastasia-gcr-nfr.cftenant.com/health
curl https://deploy-check.sso.eastasia-gcr-nfr.cftenant.com/.well-known/openid-configuration
curl -s -o /dev/null -w '%{http_code}\n' https://deploy-check.sso.eastasia-gcr-nfr.cftenant.com/admin/tenants   # 401
# 老 Worker 回归（必须仍是 200 / 302）
curl -s -o /dev/null -w '%{http_code}\n' https://sso-dingtalk-proxy.eastasia-gcr-nfr.cftenant.com/health
curl -s -o /dev/null -w '%{http_code}\n' 'https://sso-dingtalk-proxy.eastasia-gcr-nfr.cftenant.com/auth?client_id=x'
```

## 部署后：开通第一个租户

```bash
ADMIN_TOKEN=$(cat .secrets/production/ADMIN_TOKEN.txt)
curl -X POST https://deploy-check.sso.eastasia-gcr-nfr.cftenant.com/admin/tenants \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{
    "slug": "acme",
    "corpIds": ["*"],
    "dtClientId": "<客户钉钉应用 AppKey>",
    "dtClientSecret": "<AppSecret>",
    "redirects": ["https://<团队名>.cloudflareaccess.com/cdn-cgi/access/callback"]
  }'
```

响应里的 `client_id`/`client_secret` 只出现这一次，交给客户按 [docs/2-cloudflare-access.md](2-cloudflare-access.md) 填五字段。
也可以打开 `https://deploy-check.sso.eastasia-gcr-nfr.cftenant.com/admin/` 用浏览器控制台操作（登录用 ADMIN_TOKEN）。

## 日常运维

| 操作 | 命令 |
|---|---|
| 重复部署（改代码后） | `bash deploy.sh` —— D1/Secrets 阶段会检测已存在并默认跳过 |
| 只更新代码 | `npx wrangler deploy` |
| 轮换某租户签名密钥 | `POST /admin/tenants/<slug>/rotate-key`（旧密钥进入 retiring，JWKS 双活） |
| 轮换管理令牌 | `openssl rand -hex 24` → `wrangler secret put ADMIN_TOKEN` → 更新本地备份 |
| 停用租户 | `PATCH /admin/tenants/<slug>` `{"status":"disabled"}` |
| 下线整个服务 | `npx wrangler delete`（同时删除自定义域与 DNS 记录；D1 数据保留，可重新绑回） |

## 常见问题

- **`wrangler secret put` 报 Required Worker name missing**：不在仓库根目录运行。回到本目录，或脚本内部已处理。
- **部署后新域名 5xx/证书错误**：通配符证书签发需要几十秒，脚本会自动重试等待；持续失败查 Cloudflare 控制台 SSL/TLS。
- **`database_id` 还是占位符**：D1 阶段被跳过/取消了。重跑 `deploy.sh`，在 D1 阶段确认创建。
- **想换域名**：改 `wrangler.toml` 的 `SSO_BASE_DOMAIN` 和 `routes`，重跑部署；已建租户数据不受影响（issuer 会变，需客户同步改 CF 配置）。
