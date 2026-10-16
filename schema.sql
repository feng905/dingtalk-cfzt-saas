-- dingtalk-cfzt-saas 数据库结构（幂等，可重复执行）

-- 租户：一个客户 = 一个子域名 + 一套钉钉企业内部应用凭证
CREATE TABLE IF NOT EXISTS tenants (
  slug                TEXT PRIMARY KEY,          -- 子域名前缀，如 "acme"
  status              TEXT NOT NULL DEFAULT 'active',  -- active | disabled
  corp_ids            TEXT NOT NULL DEFAULT '[]',-- JSON 数组，允许登录的钉钉 corpId；["*"] = 不限
  dt_client_id        TEXT NOT NULL,             -- 钉钉 AppKey
  dt_client_secret_enc TEXT NOT NULL,            -- AES-GCM 加密后的 AppSecret
  allowed_redirects   TEXT NOT NULL DEFAULT '[]',-- JSON 数组，OIDC redirect_uri 白名单
  any_redirect        INTEGER NOT NULL DEFAULT 0,-- 1 = 跳过 CF 回调形态校验（自定义 Access 域客户用）
  email_mode          TEXT NOT NULL DEFAULT 'synthetic', -- synthetic=永远合成 | prefer_real=真实邮箱优先
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_dt_client_id ON tenants(dt_client_id);

-- OIDC client：颁发给客户（配到 CF Access IdP 表单）的凭证
CREATE TABLE IF NOT EXISTS oidc_clients (
  client_id   TEXT PRIMARY KEY,
  tenant_slug TEXT NOT NULL,
  secret_hash TEXT NOT NULL,                   -- SHA-256 hex
  secret_enc  TEXT,                            -- AES-GCM 密文（控制台可再次查看；旧库由 Worker 惰性 ALTER 补列）
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oidc_clients_tenant ON oidc_clients(tenant_slug);

-- 签名密钥：每租户独立 RSA 密钥对，私钥加密落库；轮换时旧 key 转 retiring 仍可验签
CREATE TABLE IF NOT EXISTS signing_keys (
  tenant_slug     TEXT NOT NULL,
  kid             TEXT NOT NULL,
  private_key_enc TEXT NOT NULL,               -- AES-GCM 加密的 PKCS8 PEM
  public_jwk      TEXT NOT NULL,               -- JSON {kty,n,e,kid,alg,use}
  status          TEXT NOT NULL DEFAULT 'active', -- active | retiring
  created_at      INTEGER NOT NULL,
  PRIMARY KEY (tenant_slug, kid)
);

-- 一次性 code 消费记录（防重放）
CREATE TABLE IF NOT EXISTS used_jti (
  jti        TEXT PRIMARY KEY,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_used_jti_exp ON used_jti(expires_at);

-- 登录审计（只记 unionId 与结果，不落昵称/头像/手机号 — PIPL）
CREATE TABLE IF NOT EXISTS audit_log (
  ts         INTEGER NOT NULL,
  tenant_slug TEXT NOT NULL,
  union_id   TEXT,
  action     TEXT NOT NULL,                    -- login_ok | login_fail
  detail     TEXT,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_tenant_ts ON audit_log(tenant_slug, ts);
