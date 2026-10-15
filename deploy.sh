#!/usr/bin/env bash
#
# deploy.sh — dingtalk-cfzt-saas 一键部署（交互式）
#
# 用法:
#   bash deploy.sh               交互式部署，每一步确认，Ctrl+C 随时退出
#   bash deploy.sh --dry-run     只读预演：检查环境、展示计划，不做任何变更
#   bash deploy.sh --yes         跳过全部确认（配合 CI；慎用）
#   bash deploy.sh --domain=x.y  非交互指定部署主域（跳过域名输入）
#   bash deploy.sh --help        帮助
#
# 域名机制（仓库不含真实域名）:
#   部署主域在运行时输入（或 --domain= / 本地 .deploy.env 的 DEPLOY_DOMAIN 提供），
#   服务占用 sso.<主域> 子树；脚本据此生成 wrangler.deploy.toml（gitignore），
#   真实域名、通配符路由、database_id 只存在于该本地文件，再以 --config 部署。
#
# 部署内容:
#   1. D1 数据库 dingtalk-saas（不存在则创建，id 写入本地生成的配置）
#   2. 远程建表 schema.sql（全部 IF NOT EXISTS，可重复执行）
#   3. 三个生产 Secret（ENCRYPTION_KEY / STATE_SECRET / ADMIN_TOKEN），
#      本地备份到 .secrets/production/（已 gitignore）；已存在的默认保留
#   4. wrangler deploy --config wrangler.deploy.toml
#      —— 只占用 sso.<主域> 子树，不影响主域下其他任何主机名
#   5. 部署后验证 + 同主域既有 Worker（sso-dingtalk-proxy.<主域>）回归比对
#   6. （可选）创建第一个租户
#
set -euo pipefail
cd "$(dirname "$0")"
# 优先用仓库 devDependencies 里的 wrangler（全局安装可能版本陈旧）
PATH="$PWD/node_modules/.bin:$PATH"
export PATH

# ---------- 常量 ----------
SVC_PREFIX="sso"                    # 服务子树前缀：<slug>.sso.<主域>
LEGACY_PROXY_PREFIX="sso-dingtalk-proxy"  # 同主域下老 Worker（仅用于回归比对，可不存在）
WORKER_NAME="dingtalk-cfzt-saas"
DB_NAME="dingtalk-saas"
DB_ID_PLACEHOLDER="PLACEHOLDER_DEPLOY_SCRIPT_WILL_FILL"
SECRETS_DIR=".secrets/production"
CHECK_SLUG="deploy-check"
DEPLOY_CFG="wrangler.deploy.toml"
DEPLOY_ENV=".deploy.env"

# ---------- 参数 ----------
DRY_RUN=0
ASSUME_YES=0
DOMAIN=""
for ARG in "$@"; do
  case "$ARG" in
    --dry-run)   DRY_RUN=1 ;;
    --yes)       ASSUME_YES=1 ;;
    --domain=*)  DOMAIN=$(printf '%s' "${ARG#--domain=}" | tr '[:upper:]' '[:lower:]' | tr -d ' ') ;;
    -h|--help)   sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) printf '未知参数: %s\n\n' "$ARG"; sed -n '2,25p' "$0" | sed 's/^# \{0,1\}//'; exit 1 ;;
  esac
done

# ---------- 输出工具 ----------
if [ -t 1 ]; then
  C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_B=$'\033[36m'; C_BD=$'\033[1m'; C_0=$'\033[0m'
else
  C_G=''; C_Y=''; C_R=''; C_B=''; C_BD=''; C_0=''
fi
info() { printf '%s\n' "${C_B}▸ ${C_0}$*"; }
ok()   { printf '%s\n' "${C_G}✓ ${C_0}$*"; }
warn() { printf '%s\n' "${C_Y}! ${C_0}$*"; }
die()  { printf '%s\n' "${C_R}✗ $*${C_0}" >&2; exit 1; }
stage(){ printf '\n%s━━━━ %s ━━━━%s\n' "$C_BD" "$*" "$C_0"; }

confirm() { # confirm "提示" [默认 y|n]
  [ "$ASSUME_YES" = "1" ] && return 0
  local _d="${2:-n}" _r
  while :; do
    printf '%s' "$1"
    read -r _r || die "输入中断，退出"
    _r=$(printf '%s' "$_r" | tr '[:upper:]' '[:lower:]')
    [ -z "$_r" ] && _r="$_d"
    case "$_r" in
      y|yes) return 0 ;;
      n|no)  return 1 ;;
      *)     printf '  请回答 y 或 n\n' ;;
    esac
  done
}

ask() { # ask "提示" "默认值" —— 结果放全局 REPLY
  if [ "$ASSUME_YES" = "1" ]; then
    REPLY="$2"
    return 0
  fi
  printf '%s' "$1"
  read -r REPLY || die "输入中断，退出"
  [ -z "$REPLY" ] && REPLY="$2"
  return 0
}

run() { # run cmd... —— dry-run 时只打印
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] $*"
    return 0
  fi
  "$@"
}

http_code() {
  curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$1" 2>/dev/null || printf '000'
}

# 生成 <root:wrangler.deploy.toml>（本地部署配置：真实域 + database_id，gitignore）
gen_deploy_config() { # gen_deploy_config <database_id>
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] 将生成 ${DEPLOY_CFG}（子树 ${BASE_DOMAIN}，database_id ${1}）"
    return 0
  fi
  CFG_BASE="$BASE_DOMAIN" CFG_ID="$1" python3 - <<'PYEOF'
import os, re
s = open('wrangler.toml', encoding='utf-8').read()
s = s.replace('sso.example.com', os.environ['CFG_BASE'])
s = re.sub(r'(database_id\s*=\s*)"[^"]*"',
           lambda m: m.group(1) + '"' + os.environ['CFG_ID'] + '"', s, count=1)
open('wrangler.deploy.toml', 'w', encoding='utf-8').write(s)
PYEOF
  chmod 600 "$DEPLOY_CFG" 2>/dev/null || true
  ok "已生成本地部署配置 ${DEPLOY_CFG}（真实域名与 database_id 只存在于此文件，不入库）"
}

# ══════════════════════ 预检 ══════════════════════
stage "预检"
command -v wrangler >/dev/null 2>&1 || die "未找到 wrangler，请先: npm install（本仓库自带）"
command -v python3  >/dev/null 2>&1 || die "未找到 python3"
command -v curl     >/dev/null 2>&1 || die "未找到 curl"
command -v openssl  >/dev/null 2>&1 || die "未找到 openssl"
command -v lsof     >/dev/null 2>&1 || die "未找到 lsof"
info "wrangler $(wrangler --version 2>/dev/null | tr -d ' \n')"
if ! wrangler whoami >/dev/null 2>&1; then
  die "wrangler 未登录。请先运行: npx wrangler login"
fi
wrangler whoami 2>/dev/null | sed -n '1,10p'
[ -f public/index.html ] || die "缺少 public/index.html（落地页）"
[ -f schema.sql ]        || die "缺少 schema.sql"
[ -f wrangler.toml ]     || die "缺少 wrangler.toml"

# ══════════════════════ 域名（运行时确定，不写入仓库） ══════════════════════
stage "部署主域"
ENV_DOMAIN=""
if [ -f "$DEPLOY_ENV" ]; then
  ENV_DOMAIN=$(sed -n 's/^DEPLOY_DOMAIN=//p' "$DEPLOY_ENV" | head -1 | tr -d ' \r')
fi
if [ -z "$DOMAIN" ]; then
  if [ -n "$ENV_DOMAIN" ]; then
    ask "部署主域（回车 = ${ENV_DOMAIN}）: " "$ENV_DOMAIN"
  else
    ask "部署主域（如 example.com；服务将占用 sso.example.com 这样的子树）: " ""
  fi
  DOMAIN=$(printf '%s' "$REPLY" | tr '[:upper:]' '[:lower:]' | tr -d ' ')
fi
[ -n "$DOMAIN" ] || die "未输入部署主域"
if ! printf '%s' "$DOMAIN" | grep -Eq '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'; then
  die "域名格式不对: ${DOMAIN}"
fi
BASE_DOMAIN="$SVC_PREFIX.$DOMAIN"
PROXY_HOST="$LEGACY_PROXY_PREFIX.$DOMAIN"
info "服务将占用: *.${BASE_DOMAIN}   （仅此一层子树）"
if [ "$DOMAIN" != "$ENV_DOMAIN" ] && [ "$DRY_RUN" != "1" ]; then
  umask 077
  printf 'DEPLOY_DOMAIN=%s\n' "$DOMAIN" > "$DEPLOY_ENV"
  ok "已记住到本地 ${DEPLOY_ENV}（gitignore，下次运行直接回车）"
fi

# ══════════════════════ 基线 + 计划 ══════════════════════
info "基线检查同主域既有 Worker（部署后用于回归比对；没有也不影响部署）"
OLD_HEALTH=$(http_code "https://$PROXY_HOST/health")
OLD_AUTH=$(http_code "https://$PROXY_HOST/auth?client_id=x")
if [ "$OLD_HEALTH" = "200" ]; then ok "老 Worker /health → ${OLD_HEALTH}"; else warn "老 Worker /health → ${OLD_HEALTH}（不存在或网络不通，回归比对将跳过判断）"; fi
if [ "$OLD_AUTH" = "302" ];   then ok "老 Worker /auth → ${OLD_AUTH}（路线 A 在线）"; else warn "老 Worker /auth → ${OLD_AUTH}"; fi

printf '\n'
info "部署计划:"
printf '  Worker:    %s\n' "$WORKER_NAME"
printf '  占用域名:  *.%s   （通配符自定义域，仅此一层子树）\n' "$BASE_DOMAIN"
printf '  数据库:    D1 %s\n' "$DB_NAME"
printf '  落地页:    https://%s/\n' "$BASE_DOMAIN"
printf '  本地配置:  %s（gitignore；仓库文件不含真实域名）\n' "$DEPLOY_CFG"
printf '  不触碰:    %s 等主域下其他主机名\n' "$PROXY_HOST"
printf '\n'
confirm "确认执行以上部署计划？[y/N] " || die "已取消（未做任何变更）"

# ══════════════════════ 1/5 D1 ══════════════════════
stage "1/5 D1 数据库"
REMOTE_ID=$(wrangler d1 list --json 2>/dev/null | DB_NAME="$DB_NAME" python3 -c '
import json, sys, os
try: lst = json.load(sys.stdin)
except Exception: lst = []
print(next((d.get("uuid", "") for d in lst if d.get("name") == os.environ["DB_NAME"]), ""))
') || REMOTE_ID=""

if [ -n "$REMOTE_ID" ]; then
  ok "D1 $DB_NAME 已存在（${REMOTE_ID}），直接复用"
else
  info "远程不存在 D1 $DB_NAME"
  if confirm "创建 D1 数据库 ${DB_NAME}？[Y/n] "; then
    if [ "$DRY_RUN" = "1" ]; then
      info "[dry-run] wrangler d1 create $DB_NAME"
      REMOTE_ID="<创建后自动填入>"
    else
      OUT=$(wrangler d1 create "$DB_NAME" 2>&1) || { printf '%s\n' "$OUT" >&2; die "创建 D1 失败"; }
      REMOTE_ID=$(printf '%s' "$OUT" | grep -Eo '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}' | head -1)
      [ -n "$REMOTE_ID" ] || { printf '%s\n' "$OUT" >&2; die "无法解析 database_id"; }
      ok "已创建 D1（${REMOTE_ID}）"
    fi
  else
    die "没有 D1 无法继续，已取消"
  fi
fi
gen_deploy_config "$REMOTE_ID"

# ══════════════════════ 2/5 建表 ══════════════════════
stage "2/5 远程建表"
info "wrangler d1 execute DB --remote --file=schema.sql（全部 IF NOT EXISTS，可重复执行）"
confirm "在远程 D1 上执行建表？[Y/n] " || die "已取消"
run wrangler d1 execute DB --config "$DEPLOY_CFG" --remote --file=schema.sql -y

# ══════════════════════ 3/5 Secrets ══════════════════════
stage "3/5 生产 Secrets"
if [ "$DRY_RUN" != "1" ]; then
  mkdir -p "$SECRETS_DIR"
  chmod 700 "$SECRETS_DIR" 2>/dev/null || true
fi
EXISTING=$(wrangler secret list --config "$DEPLOY_CFG" --json 2>/dev/null || printf '[]')

has_secret() {
  EXISTING="$EXISTING" SECRET_NAME="$1" python3 -c '
import json, os
try: lst = json.loads(os.environ["EXISTING"])
except Exception: lst = []
print("yes" if any(s.get("name") == os.environ["SECRET_NAME"] for s in lst) else "no")
'
}

gen_and_put() { # gen_and_put <NAME>
  local NAME="$1" LEN VAL F
  case "$NAME" in ADMIN_TOKEN) LEN=24 ;; *) LEN=32 ;; esac
  VAL=$(openssl rand -hex "$LEN") || { die "openssl 生成随机数失败"; return 0; }
  F="$SECRETS_DIR/$NAME.txt"
  if [ "$DRY_RUN" != "1" ]; then
    printf '%s' "$VAL" > "$F"
    chmod 600 "$F"
  fi
  printf '\n'
  if [ "$DRY_RUN" = "1" ]; then
    info "（dry-run 预览值，正式运行会重新生成）本地备份: $F"
  else
    ok "$NAME 已生成，本地备份: $F"
  fi
  printf '  %s值（仅此一次展示，之后不再回显）: %s%s%s\n\n' "$C_Y" "$C_BD" "$VAL" "$C_0"
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] 跳过: wrangler secret put $NAME"
    return 0
  fi
  if confirm "把 $NAME 设置到 Worker？[Y/n] "; then
    if wrangler secret put "$NAME" --config "$DEPLOY_CFG" < "$F" >/dev/null 2>&1; then
      ok "$NAME 已设置到 $WORKER_NAME"
    else
      die "wrangler secret put $NAME 失败（可手动重试: wrangler secret put $NAME < ${F}）"
    fi
  else
    warn "已跳过。稍后手动: wrangler secret put $NAME < ${F}"
  fi
}

for NAME in ENCRYPTION_KEY STATE_SECRET ADMIN_TOKEN; do
  if [ "$(has_secret "$NAME")" = "yes" ]; then
    warn "$NAME 已存在于 Worker"
    info "覆盖影响: ENCRYPTION_KEY→存量租户凭证失效 / STATE_SECRET→进行中登录失效 / ADMIN_TOKEN→旧管理令牌失效"
    if confirm "重新生成并覆盖 ${NAME}？[y/N] "; then
      gen_and_put "$NAME"
    else
      ok "保留现有 $NAME"
    fi
  else
    info "$NAME 不存在，将生成"
    gen_and_put "$NAME"
  fi
done

# ══════════════════════ 4/5 部署 ══════════════════════
stage "4/5 部署"
if [ "$DRY_RUN" != "1" ] && grep -q "$DB_ID_PLACEHOLDER" "$DEPLOY_CFG" 2>/dev/null; then
  die "本地配置的 database_id 仍是占位符（D1 阶段未完成），请重跑并在 D1 阶段确认创建"
fi
if [ "$DRY_RUN" != "1" ] && [ ! -f "$DEPLOY_CFG" ]; then
  die "缺少本地配置 ${DEPLOY_CFG}（D1 阶段应已生成）"
fi
info "wrangler deploy —— 将创建/更新自定义域 *.${BASE_DOMAIN}"
confirm "执行部署？[Y/n] " || die "已取消"
run wrangler deploy --config "$DEPLOY_CFG"

# ══════════════════════ 5/5 验证 ══════════════════════
stage "5/5 部署后验证"
CHECK_HOST="$CHECK_SLUG.$BASE_DOMAIN"
PASS=0
FAIL=0
vcheck() { # vcheck "名称" "期望" "实际"
  if [ "$3" = "$2" ]; then
    ok "$1 → $3"; PASS=$((PASS + 1))
  else
    warn "$1 → ${3}（期望 ${2}）"; FAIL=$((FAIL + 1))
  fi
}

if [ "$DRY_RUN" = "1" ]; then
  info "[dry-run] 跳过线上验证"
else
  info "等待新域名生效（首次部署证书签发需要几十秒）..."
  CODE="000"
  i=0
  while [ $i -lt 12 ]; do
    CODE=$(http_code "https://$CHECK_HOST/health")
    [ "$CODE" = "200" ] && break
    i=$((i + 1))
    sleep 5
  done
  vcheck "新域名 /health" "200" "$CODE"

  ISSUER=$(curl -s --max-time 10 "https://$CHECK_HOST/.well-known/openid-configuration" \
    | python3 -c '
import json, sys
try: print(json.load(sys.stdin).get("issuer", ""))
except Exception: print("")
') || ISSUER=""
  if [ "$ISSUER" = "https://$CHECK_HOST" ]; then
    ok "discovery issuer = $ISSUER"; PASS=$((PASS + 1))
  else
    warn "discovery issuer 异常: ${ISSUER:-<无响应>}"; FAIL=$((FAIL + 1))
  fi

  vcheck "/admin 未带令牌" "401" "$(http_code "https://$CHECK_HOST/admin/tenants")"
  if [ "$OLD_HEALTH" = "200" ]; then
    vcheck "老 Worker /health 回归" "200" "$(http_code "https://$PROXY_HOST/health")"
    vcheck "老 Worker /auth 回归（路线 A）" "$OLD_AUTH" "$(http_code "https://$PROXY_HOST/auth?client_id=x")"
  else
    info "老 Worker 部署前不可达，跳过回归比对"
  fi

  printf '\n'
  if [ $FAIL -eq 0 ]; then
    ok "验证全部通过（$PASS 项），老 Worker 无回归"
  else
    warn "$PASS 项通过 / $FAIL 项异常 —— 按上方输出排查；必要时回滚: npx wrangler delete --config ${DEPLOY_CFG}"
  fi
fi

# ══════════════════════ 附加：第一个租户 ══════════════════════
stage "附加：创建第一个租户（可跳过）"
create_first_tenant() {
  local SLUG TEAM CORP DT_ID DT_SECRET ADMIN_TOKEN_VAL BODY RESP CID CSEC
  ADMIN_TOKEN_VAL=""
  if [ -f "$SECRETS_DIR/ADMIN_TOKEN.txt" ]; then
    ADMIN_TOKEN_VAL=$(cat "$SECRETS_DIR/ADMIN_TOKEN.txt")
  else
    ask "输入现有 ADMIN_TOKEN（回车放弃）: " ""
    ADMIN_TOKEN_VAL="$REPLY"
  fi
  [ -n "$ADMIN_TOKEN_VAL" ] || { warn "没有 ADMIN_TOKEN，跳过"; return 1; }

  while :; do
    ask "租户子域 slug（如 acme；回车放弃创建）: " ""
    [ -z "$REPLY" ] && { warn "未输入 slug，跳过创建租户"; return 1; }
    SLUG=$(printf '%s' "$REPLY" | tr '[:upper:]' '[:lower:]' | tr -d ' ')
    if printf '%s' "$SLUG" | grep -Eq '^[a-z0-9][a-z0-9-]{0,31}$'; then break; fi
    warn "slug 限制：小写字母/数字/连字符，字母或数字开头，最长 32 位"
  done

  ask "CF 团队域名前缀（如 yourteam，对应 https://yourteam.cloudflareaccess.com）: " ""
  TEAM="$REPLY"
  [ -n "$TEAM" ] || { warn "未输入团队域名，跳过"; return 1; }
  ask "corpId 白名单（回车 = * 不限；多个用英文逗号分隔）: " "*"
  CORP="$REPLY"
  ask "钉钉应用 AppKey（Client ID）: " ""
  DT_ID="$REPLY"
  [ -n "$DT_ID" ] || { warn "未输入 AppKey，跳过"; return 1; }
  printf '钉钉应用 AppSecret（Client Secret）: '
  read -r DT_SECRET || { warn "输入中断，跳过"; return 1; }
  [ -n "$DT_SECRET" ] || { warn "未输入 AppSecret，跳过"; return 1; }

  BODY=$(SLUG="$SLUG" TEAM="$TEAM" CORP="$CORP" DTID="$DT_ID" DTSECRET="$DT_SECRET" python3 -c '
import json, os
corp = os.environ["CORP"]
if corp in ("", "*"):
    corps = ["*"]
else:
    corps = [x.strip() for x in corp.split(",") if x.strip()]
print(json.dumps({
    "slug": os.environ["SLUG"],
    "corpIds": corps,
    "dtClientId": os.environ["DTID"],
    "dtClientSecret": os.environ["DTSECRET"],
    "redirects": ["https://%s.cloudflareaccess.com/cdn-cgi/access/callback" % os.environ["TEAM"]],
}))')

  RESP=$(curl -s --max-time 15 -X POST "https://$CHECK_HOST/admin/tenants" \
    -H "Authorization: Bearer $ADMIN_TOKEN_VAL" \
    -H "Content-Type: application/json" \
    -d "$BODY") || RESP=""

  printf '%s' "$RESP" | python3 -m json.tool 2>/dev/null || printf '%s\n' "$RESP"
  CID=$(printf '%s' "$RESP" | python3 -c '
import json, sys
try: print(json.load(sys.stdin).get("client_id", ""))
except Exception: print("")
')
  CSEC=$(printf '%s' "$RESP" | python3 -c '
import json, sys
try: print(json.load(sys.stdin).get("client_secret", ""))
except Exception: print("")
')
  if [ -n "$CID" ] && [ -n "$CSEC" ]; then
    printf '\n'
    ok "租户创建成功 —— 以下信息交给客户（client_secret 只显示这一次）"
    printf '  租户入口:      https://%s.%s\n' "$SLUG" "$BASE_DOMAIN"
    printf '  Client ID:     %s\n' "$CID"
    printf '  Client Secret: %s\n' "$CSEC"
    printf '  CF Access 五字段:\n'
    printf '    Auth URL:       https://%s.%s/authorize\n' "$SLUG" "$BASE_DOMAIN"
    printf '    Token URL:      https://%s.%s/token\n' "$SLUG" "$BASE_DOMAIN"
    printf '    Certificate URL: https://%s.%s/jwks\n' "$SLUG" "$BASE_DOMAIN"
    printf '    （PKCE 不开；完整步骤见 docs/2-cloudflare-access.md）\n'
  else
    warn "创建失败或返回异常（见上方原始响应）"
    return 1
  fi
}

if confirm "现在创建第一个租户？[y/N] "; then
  if [ "$DRY_RUN" = "1" ]; then
    info "[dry-run] 跳过创建租户"
  else
    create_first_tenant || warn "租户未创建（可稍后用管理 API 或浏览器控制台创建，见 docs/deploy.md）"
  fi
fi

# ══════════════════════ 完成 ══════════════════════
printf '\n'
stage "完成"
if [ "$DRY_RUN" = "1" ]; then
  ok "dry-run 结束，未做任何变更。去掉 --dry-run 正式执行。"
else
  ok "部署完成。落地页: https://$BASE_DOMAIN/"
  ok "管理控制台: https://$CHECK_HOST/admin/ （用 ADMIN_TOKEN 登录）"
  info "下一步: 客户按 docs/1-dingtalk-app.md 建钉钉应用 → docs/2-cloudflare-access.md 配五字段 → Test 按钮真实扫码验证"
fi
