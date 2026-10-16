# 生产部署手册

服务部署在 Cloudflare Workers 上，占用 **`sso.<部署主域>`** 子树。
本文档是完整部署步骤：推荐用一键脚本 `deploy.sh`（交互式确认），也给出等价的手工命令。

> **仓库不含真实域名**。部署主域在运行时确定（交互输入 / `--domain=` 参数 /
> 本地 `.deploy.env` 的 `DEPLOY_DOMAIN`），脚本据此生成本地 `wrangler.deploy.toml`
> （gitignore）——真实域名、主机名路由、database_id 只存在于该文件，全程 `--config` 引用。
> 下文用 `sso.example.com` 指代「你的服务子树」。

> **为什么每租户一条精确主机名**：Cloudflare Custom Domains 不支持通配符
> （`wrangler deploy` 会直接拒绝 `*.sso.…`）。每条路由是子树内一条完整主机名，
> Cloudflare 自动创建 DNS 记录并自动签发证书——包括 `acme.sso.<主域>` 这类
> 两级子域（Universal SSL 免费证书只覆盖一级，Custom Domain 不受限）。
> 加租户 = 追加一条主机名重新部署：`bash deploy.sh --add-domain=<slug>.sso.<主域>`。

```
┌─ Cloudflare 账号（<部署主域> zone）────────────────────────────────┐
│                                                                    │
│  <主域下其他主机名>……（例如已有的 sso-dingtalk-proxy.<主域>）← 不动  │
│                                                                    │
│  sso.<部署主域> 子树（逐条精确注册，不用通配符）   ← 本次部署占用     │
│    ├─ deploy-check.sso.…  验证入口 + 管理控制台（每次部署自动包含）   │
│    ├─ acme.sso.…          每租户一条主机名 = 该租户的 OIDC issuer    │
│    └─ <slug>.sso.…        加租户 = --add-domain 追加后重新部署        │
│                                                                    │
│  Worker: dingtalk-cfzt-saas（含落地页 public/index.html）           │
│  D1:     dingtalk-saas（tenants / oidc_clients / signing_keys /     │
│          used_jti / audit_log）                                     │
└────────────────────────────────────────────────────────────────────┘
```

## 隔离保证（为什么不会影响其他域名）

1. **只注册子树内的精确主机名**：服务注册的每一条路由都是 `sso.<部署主域>` 子树内的
   完整主机名（如 `acme.sso.…`）。主域下任何既有主机名（如 `sso-dingtalk-proxy.<主域>`）
   不在该子树内，结构上就匹配不到；追加租户也只是新增更深的子域主机名，
   不会改动主域下任何一层既有主机名的 DNS 或路由。
2. **部署按 Worker 隔离**：`wrangler deploy` 只上传/变更配置里 `name` 指定的这一个 Worker，
   其他 Worker 的代码、Secrets、自定义域都不会被触碰。
3. **脚本前后回归比对**：`deploy.sh` 部署前记录 `sso-dingtalk-proxy.<主域>` 的基线
   （`/health` 200、`/auth` 302，不存在则自动跳过），部署后重新探测比对，任何回归都会报出来。

## 前置条件

- 本机已装 Node，仓库内已 `npm install`（自带 wrangler，脚本优先用仓库本地版本）
- 已登录且账号能操作 `<部署主域>` 所在 zone：`npx wrangler login`
- `python3`、`curl`、`openssl`、`lsof`（macOS 自带）
- 在仓库根目录运行（`deploy.sh` 自己也会 cd 过去）

## 一键部署（推荐）

```bash
bash deploy.sh --dry-run           # 预演：只读检查 + 展示计划
bash deploy.sh                     # 正式部署
bash deploy.sh --domain=example.com  # 非交互指定主域
```

脚本全程交互，每一步都会确认；随时 Ctrl+C 退出。各阶段会问什么：

| 阶段 | 交互 | 脚本做什么 |
|---|---|---|
| 预检 | 无 | wrangler 登录检查、版本确认（优先 `node_modules/.bin`） |
| 部署主域 | 输入（回车=上次值） | 校验格式；推导 `sso.<主域>`；记住到本地 `.deploy.env`（gitignore） |
| 基线+计划 | 确认部署计划 | 探测 `sso-dingtalk-proxy.<主域>` 基线；列出将占用/不触碰的域名 |
| 1 D1 | 确认建库 | `d1 list` 查重 → 不存在则 `d1 create`；生成 `wrangler.deploy.toml`（真实域+database_id） |
| 2 建表 | 确认执行 | `d1 execute DB --config … --remote --file=schema.sql`（全部 `IF NOT EXISTS`，可重复跑） |
| 3 Secrets | 展示一次 + 确认写入 | 生成 ENCRYPTION_KEY / STATE_SECRET / ADMIN_TOKEN，备份到 `.secrets/production/`（已 gitignore），逐个 `secret put --config …`；已存在的默认保留 |
| 3.5 域名自动开通 | 可选，推荐确认 | 配置 CF_API_TOKEN + CF_ACCOUNT_ID，Worker 建租户时自己调 CF API 注册域名（见下节） |
| 4 部署 | 最终确认 | `wrangler deploy --config wrangler.deploy.toml`（注册 deploy-check 入口与各租户主机名的 Custom Domain，DNS+证书自动签发） |
| 5 验证 | 无（自动） | 新域名 /health、discovery issuer、/admin 401；老 Worker 两项回归比对 |
| 附加 | 可跳过 | 可选：现场创建第一个租户，打印 client_id/secret 和 CF Access 五字段；确认后自动把其主机名加入路由并重新部署 |

Secrets 只在生成时展示一次，之后保存在 `.secrets/production/`（权限 600），脚本不会回显。

### 域名自动开通（3.5 阶段，可选但强烈推荐）

配置后**建租户即自动注册域名**（Worker 调 Cloudflare API 挂 Custom Domain，DNS 与证书自动签发），
控制台也会有「开通域名」按钮兜底；不配置则每次建完租户要跑一次 `bash deploy.sh --code-only`。

脚本会引导你在 Cloudflare 控制台创建一个**最小权限** API Token：

1. 打开 <https://dash.cloudflare.com/profile/api-tokens> → **创建令牌** → **创建自定义令牌**
2. 权限：`Account` → `Workers Scripts` → `Edit`
3. 区域资源：`包括` → `特定区域` → 选择部署主域所在的 zone
   （仅这两项，Token 读不到账号里的其他资源）
4. 创建后把 Token 值粘贴回脚本（输入不回显）；脚本会依次校验 Token 有效性与域名 API 权限，
   然后写入 Worker Secret（本地备份 `.secrets/production/CF_API_TOKEN.txt`），
   并把 `CF_ACCOUNT_ID` 记入 `.deploy.env`（从 whoami 自动提取，无需手填）

已配置过的运行会自动跳过这一步（检测 Secret 已存在 + `.deploy.env` 有 Account ID）。

## 手工分步部署（与脚本等价）

```bash
# 0. 确定主域与子树（示例以 example.com 为部署主域）
BASE_DOMAIN="sso.example.com"

# 1. D1 建库
npx wrangler d1 create dingtalk-saas
#   复制 wrangler.toml 为本地部署配置（gitignore），替换域名与 database_id：
cp wrangler.toml wrangler.deploy.toml
#   编辑 wrangler.deploy.toml：
#     - 所有 sso.example.com → sso.<你的主域>
#     - database_id = "<d1 create 输出的 id>"
chmod 600 wrangler.deploy.toml

# 2. 远程建表（幂等）
npx wrangler d1 execute DB --config wrangler.deploy.toml --remote --file=schema.sql -y

# 3. 生产 Secrets（各生成一次，妥善保存；必须全新生成，勿复用其他 Worker 的）
openssl rand -hex 32   # → ENCRYPTION_KEY
openssl rand -hex 32   # → STATE_SECRET
openssl rand -hex 24   # → ADMIN_TOKEN
npx wrangler secret put ENCRYPTION_KEY --config wrangler.deploy.toml     # 回车后粘贴值
npx wrangler secret put STATE_SECRET     --config wrangler.deploy.toml
npx wrangler secret put ADMIN_TOKEN      --config wrangler.deploy.toml

# 4. 部署
npx wrangler deploy --config wrangler.deploy.toml

# 5. 验证（把 deploy-check.sso.example.com 换成你的子树）
curl https://deploy-check.sso.example.com/health
curl https://deploy-check.sso.example.com/.well-known/openid-configuration
curl -s -o /dev/null -w '%{http_code}\n' https://deploy-check.sso.example.com/admin/tenants   # 401
# 同主域既有 Worker 回归（如有；必须与部署前一致）
curl -s -o /dev/null -w '%{http_code}\n' https://sso-dingtalk-proxy.example.com/health
curl -s -o /dev/null -w '%{http_code}\n' 'https://sso-dingtalk-proxy.example.com/auth?client_id=x'
```

## 部署后：开通第一个租户

```bash
ADMIN_TOKEN=$(cat .secrets/production/ADMIN_TOKEN.txt)
curl -X POST https://deploy-check.sso.example.com/admin/tenants \
  -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{
    "slug": "acme",
    "corpIds": ["*"],
    "dtClientId": "<客户钉钉应用 AppKey>",
    "dtClientSecret": "<AppSecret>",
    "redirects": ["https://<团队名>.cloudflareaccess.com/cdn-cgi/access/callback"]
  }'
```

响应里的 `client_id`/`client_secret` 只出现这一次，交给客户按 [docs/2-cloudflare-access.md](2-cloudflare-access.md) 填五字段。
也可以打开 `https://deploy-check.sso.example.com/admin/` 用浏览器控制台操作（登录用 ADMIN_TOKEN）。

### 开通租户主机名路由

租户创建后，其入口 `<slug>.sso.<主域>` 还需注册为 Custom Domain 才能解析（自动建 DNS + 签发证书）。
两条路径，按优先级：

1. **自动开通（配置了 3.5 阶段后默认）**：创建租户时 Worker 现场注册，无需任何操作；
   控制台域名卡上的「开通域名」按钮可对任何租户随时补挂（幂等）。
2. **部署脚本路径**（未配置自动开通，或想一次性注册全部存量租户）：

```bash
bash deploy.sh --code-only   # 只更新代码/路由：从 D1 读出所有租户，逐条注册后部署
```

部署计划里会列出将注册的每个租户主机名，部署后轮询证书就绪。也可以在管理控制台
（`https://deploy-check.sso.<主域>/admin/`）用「检测」按钮确认生效。

`--add-domain=<主机名>` 仅用于注册**不在 D1 里的额外主机名**（追加到本地 `.tenant-domains`）。

> ⚠️ **不要用 `npx wrangler deploy --config …` 直接更新代码**：本地生成的配置可能是旧的，
> 而 wrangler 部署会**删除配置里没有的**租户域名（changeset replace 语义）。
> `--code-only` 每次从 D1 重新生成配置，永远是最新全集。

## 日常运维

| 操作 | 命令 |
|---|---|
| 重复部署（改代码后） | `bash deploy.sh` —— D1/Secrets 阶段会检测已存在并默认跳过；主域直接回车复用 |
| 只更新代码/开通新租户域名 | `bash deploy.sh --code-only`（配置从 D1 重新生成，自动带上全部租户域名） |
| 轮换某租户签名密钥 | `POST /admin/tenants/<slug>/rotate-key`（旧密钥进入 retiring，JWKS 双活） |
| 轮换管理令牌 | `openssl rand -hex 24` → `wrangler secret put ADMIN_TOKEN --config wrangler.deploy.toml` → 更新本地备份 |
| 停用租户 | `PATCH /admin/tenants/<slug>` `{"status":"disabled"}` |
| 下线整个服务 | `npx wrangler delete --config wrangler.deploy.toml`（同时删除自定义域与 DNS 记录；D1 数据保留，可重新绑回） |

## 常见问题

- **`wrangler secret put` 报 Required Worker name missing**：不在仓库根目录运行。回到本目录，或脚本内部已处理。
- **部署后新域名 5xx/证书错误**：Custom Domain 的 DNS 与证书签发需要几十秒到几分钟，脚本会轮询等待；持续失败查 Cloudflare 控制台 SSL/TLS → Custom Hostnames。
- **为什么不能用通配符域名**：Cloudflare Custom Domains 明确不支持 `*`（wrangler 直接拒绝）；Workers 通配符 Routes 又需要每主机名手工建 DNS 记录，且两级子域（`acme.sso.…`）不在 Universal SSL 免费证书覆盖内，需付费 Total TLS/ACM。所以按租户逐条注册精确 Custom Domain 是唯一免费且自动化的路径。
- **直接 `wrangler deploy`（不带 --config）会怎样**：用的是模板 `wrangler.toml`（占位域 example.com、占位 database_id），部署会失败或落在 workers.dev——所以仓库里 `npm run deploy` 已指向 `deploy.sh`，别绕过。
- **换部署主域**：重新跑 `deploy.sh` 输入新主域即可生成新配置；旧域的自定义域路由需在 CF 控制台删掉，且已建租户的 issuer 会变，客户 CF 配置要同步改。
- **`.deploy.env` / `wrangler.deploy.toml` / `.tenant-domains` / `.secrets/`**：都已 gitignore，真实域名与密钥只存在于本机。
