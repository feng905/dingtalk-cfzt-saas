#!/usr/bin/env bash
# e2e.sh — 本地端到端测试：mock 钉钉 + wrangler dev（本地 D1），走完整 OIDC 流程
# 用法：bash test/e2e.sh   （需要先存在 .dev.vars；脚本会自动建表、起服务、跑断言）
set -u
cd "$(dirname "$0")/.."

W="http://demo.sso.example.com:8787"          # 走 --resolve 映射到 127.0.0.1:8787
MOCK="http://127.0.0.1:9901"
ADMIN="http://127.0.0.1:8787"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "  ✅ $1"; }
bad()  { FAIL=$((FAIL+1)); echo "  ❌ $1"; }
check(){ if [ "$2" = "$3" ]; then ok "$1 ($2)"; else bad "$1: got [$2] want [$3]"; fi }

jqval() { python3 -c "import json,sys;d=json.load(sys.stdin);print(d$1)" 2>/dev/null; }
loc()   { grep -i '^location:' | head -1 | sed 's/^[Ll]ocation: //' | tr -d '\r'; }

cleanup() {
  [ -n "${MOCK_PID:-}" ] && kill $MOCK_PID 2>/dev/null
  [ -n "${WRANGLER_PID:-}" ] && kill $WRANGLER_PID 2>/dev/null
  # 杀掉 npx 父进程后 workerd 子进程可能存活并占着 8787（拿着已删除的旧库句柄）——补刀
  sleep 1
  lsof -ti:8787 2>/dev/null | xargs kill -9 2>/dev/null
  lsof -ti:9901 2>/dev/null | xargs kill -9 2>/dev/null
  true
}
trap cleanup EXIT

echo "▶ 0. 重置本地 D1 并建表"
# 清掉上次运行可能残留的孤儿 dev/mock 进程（否则健康检查打到旧实例上，全部断言失真）
lsof -ti:8787 2>/dev/null | xargs kill -9 2>/dev/null
lsof -ti:9901 2>/dev/null | xargs kill -9 2>/dev/null
sleep 1
rm -rf .wrangler/state
npx wrangler d1 execute DB --local --file=schema.sql >/dev/null 2>&1 || { echo "schema 失败"; exit 1; }

echo "▶ 1. 起 mock 钉钉 + wrangler dev"
node test/mock-dingtalk.js >/tmp/mock.log 2>&1 & MOCK_PID=$!
npx wrangler dev --port 8787 >/tmp/wrangler-dev.log 2>&1 & WRANGLER_PID=$!

for i in $(seq 1 60); do curl -sf http://127.0.0.1:8787/health >/dev/null 2>&1 && break; sleep 1; done
curl -sf http://127.0.0.1:8787/health >/dev/null || { echo "wrangler dev 未就绪"; tail -20 /tmp/wrangler-dev.log; exit 1; }
ok "服务就绪"

ADMIN_TOKEN=$(grep '^ADMIN_TOKEN' .dev.vars | cut -d= -f2)
RESOLVE="--resolve demo.sso.example.com:8787:127.0.0.1"

echo "▶ 2. 管理面"
code=$(curl -s -o /dev/null -w '%{http_code}' $ADMIN/admin/tenants)
check "无 token 访问 admin → 401" "$code" "401"

CREATE=$(curl -s -X POST $ADMIN/admin/tenants -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{
  "slug": "demo", "corpIds": ["ding-corp-ok"],
  "dtClientId": "dt-mock-id", "dtClientSecret": "dt-mock-secret",
  "redirects": ["https://demo-team.cloudflareaccess.com/cdn-cgi/access/callback"]}')
CID=$(echo "$CREATE" | jqval "['oidc']['client_id']")
CSEC=$(echo "$CREATE" | jqval "['oidc']['client_secret']")
[ -n "$CID" ] && ok "创建租户 demo client_id=${CID}" || { bad "创建租户: $CREATE"; exit 1; }

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $ADMIN/admin/tenants -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{"slug":"demo","corpIds":["*"],"dtClientId":"x","dtClientSecret":"y","redirects":["https://t.cloudflareaccess.com/cdn-cgi/access/callback"]}')
check "重复 slug → 409" "$code" "409"

# 租户 B：corpId 白名单不含 mock 应用 B 的 corp → 用于拒绝测试
CREATE_B=$(curl -s -X POST $ADMIN/admin/tenants -H "Authorization: Bearer $ADMIN_TOKEN" -H "Content-Type: application/json" -d '{
  "slug": "demo-b", "corpIds": ["some-other-corp"],
  "dtClientId": "dt-mock-b", "dtClientSecret": "dt-mock-secret-b",
  "redirects": ["https://demo-team.cloudflareaccess.com/cdn-cgi/access/callback"]}')
[ -n "$(echo "$CREATE_B" | jqval "['oidc']['client_id']")" ] && ok "创建租户 demo-b" || bad "创建 demo-b: $CREATE_B"

REDIR="https%3A%2F%2Fdemo-team.cloudflareaccess.com%2Fcdn-cgi%2Faccess%2Fcallback"

echo "▶ 3. OIDC 端点基础"
code=$(curl -s -o /dev/null -w '%{http_code}' $RESOLVE "$W/.well-known/openid-configuration")
check "discovery → 200" "$code" "200"
iss=$(curl -s $RESOLVE "$W/.well-known/openid-configuration" | jqval "['issuer']")
check "issuer" "$iss" "https://demo.sso.example.com"
nk=$(curl -s $RESOLVE "$W/jwks" | jqval "['keys'][0]['kid']")
[ -n "$nk" ] && ok "jwks 有租户公钥 kid=${nk}" || bad "jwks 空"
code=$(curl -s -o /dev/null -w '%{http_code}' $RESOLVE "$W/authorize?client_id=WRONG&redirect_uri=$REDIR&state=s&nonce=n")
check "authorize 坏 client_id → 400" "$code" "400"
code=$(curl -s -o /dev/null -w '%{http_code}' $RESOLVE "$W/authorize?client_id=$CID&redirect_uri=https%3A%2F%2Fevil.com%2Fcb&state=s&nonce=n")
check "authorize 非白名单 redirect_uri → 400" "$code" "400"

echo "▶ 4. 完整授权流程（mock 扫码）"
L1=$(curl -s -o /dev/null -D - $RESOLVE "$W/authorize?client_id=$CID&redirect_uri=$REDIR&state=cfstate&nonce=nonce123" | loc)
case "$L1" in "$MOCK/oauth2/auth"*) ok "authorize → 302 mock 钉钉";; *) bad "authorize Location: $L1"; exit 1;; esac
L2=$(curl -s -o /dev/null -D - "$L1" | loc)
case "$L2" in "$W/cb?authCode="*) ok "钉钉扫码 → 302 回 /cb";; *) bad "cb Location: $L2"; exit 1;; esac
L3=$(curl -s -o /dev/null -D - $RESOLVE "$L2" | loc)
case "$L3" in "https://demo-team.cloudflareaccess.com/cdn-cgi/access/callback?code=dtc1."*) ok "/cb → 302 回 CF 回调（一次性 code）";; *) bad "CF 回调 Location: $L3"; exit 1;; esac

CODE=$(python3 -c "from urllib.parse import urlparse,parse_qs;print(parse_qs(urlparse('$L3').query)['code'][0])")
STATE=$(python3 -c "from urllib.parse import urlparse,parse_qs;print(parse_qs(urlparse('$L3').query)['state'][0])")
check "回传 CF 的 state 原样" "$STATE" "cfstate"

echo "▶ 5. /token 换 id_token"
TOK=$(curl -s -X POST $RESOLVE "$W/token" -u "$CID:$CSEC" -d "grant_type=authorization_code&code=$CODE&redirect_uri=$REDIR")
IDT=$(echo "$TOK" | jqval "['id_token']")
[ -n "$IDT" ] && ok "id_token 签发" || { bad "/token 响应: $TOK"; exit 1; }

CLAIMS=$(python3 -c "
import base64,json,sys
p='$IDT'.split('.')[1]; p+='='*(-len(p)%4)
d=json.loads(base64.urlsafe_b64decode(p))
print(d['iss'], d['sub'], d['aud'], d['nonce'], d['email'])")
read -r GISS GSUB GAUD GNON GEMAIL <<< "$CLAIMS"
check "iss"  "$GISS" "https://demo.sso.example.com"
check "sub"  "$GSUB" "u-mock-123"
check "aud"  "$GAUD" "$CID"
check "nonce 回显" "$GNON" "nonce123"
check "email 合成" "$GEMAIL" "u-mock-123@dingtalk.local"

UI=$(curl -s $RESOLVE "$W/userinfo" -H "Authorization: Bearer $IDT")
check "userinfo sub" "$(echo "$UI" | jqval "['sub']")" "u-mock-123"

echo "▶ 6. 重放防护"
code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $RESOLVE "$W/token" -u "$CID:$CSEC" -d "grant_type=authorization_code&code=$CODE&redirect_uri=$REDIR")
check "同一 code 二次 /token → 400" "$code" "400"

code=$(curl -s -o /dev/null -w '%{http_code}' -X POST $RESOLVE "$W/token" -u "$CID:wrong-secret" -d "grant_type=authorization_code&code=x")
check "错误 client secret → 401" "$code" "401"

echo "▶ 7. corpId 准入"
CID_B=$(echo "$CREATE_B" | jqval "['oidc']['client_id']")
RESOLVE_B="--resolve demo-b.sso.example.com:8787:127.0.0.1"
LB1=$(curl -s -o /dev/null -D - $RESOLVE_B "http://demo-b.sso.example.com:8787/authorize?client_id=$CID_B&redirect_uri=$REDIR&state=s&nonce=n" | loc)
LB2=$(curl -s -o /dev/null -D - "$LB1" | loc)
CB=$(curl -s $RESOLVE_B "$LB2")
check "corpId 不在白名单 → 403 access_denied" "$(echo "$CB" | jqval "['error']")" "access_denied"

echo "▶ 8. state 防篡改"
code=$(curl -s -o /dev/null -w '%{http_code}' $RESOLVE "$W/cb?authCode=x&state=oidc1.eyJ0IjoiZGVtbyJ9.BADSIG")
check "篡改签名 state → 400" "$code" "400"

echo "▶ 9. 审计日志"
LOGS=$(curl -s $ADMIN/admin/tenants/demo/logs -H "Authorization: Bearer $ADMIN_TOKEN")
echo "$LOGS" | grep -q '"action":"login_ok"' && ok "audit 有 login_ok" || bad "audit 缺 login_ok: $LOGS"
LOGS_B=$(curl -s $ADMIN/admin/tenants/demo-b/logs -H "Authorization: Bearer $ADMIN_TOKEN")
echo "$LOGS_B" | grep -q 'corpId denied' && ok "audit 有 corpId 拒绝记录" || bad "audit 缺 corpId 拒绝: $LOGS_B"

echo ""
echo "════════════════════════════"
echo "结果: PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] && echo "🎉 全部通过" || exit 1
