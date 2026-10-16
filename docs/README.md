# 客户接入文档索引

三篇文档，按顺序走完即可上线：

1. [钉钉开放平台建应用（10 分钟）](1-dingtalk-app.md) — 拿到 AppKey/AppSecret，配置回调白名单
2. [Cloudflare Zero Trust 配置（5 分钟）](2-cloudflare-access.md) — 五个字段填进 OIDC 登录方式，Test 按钮验证
3. [排错对照表](3-troubleshooting.md) — 每一步可能遇到的报错与解决办法

> 💡 从你的租户地址打开本文档（`https://你的租户地址/docs`）时，文档里的回调地址、
> OIDC URL 和 Client ID 会自动替换成你的真实值，无需再手工替换占位符。

---

## 接入总览

```
你（客户）                     服务运营                        钉钉 / Cloudflare
   │  ①按文档1建钉钉应用              │
   │ ─AppKey/AppSecret/团队域名───▶  │  ②开通租户（分钟级）
   │ ◀──client_id/client_secret────  │
   │  ③按文档2在 CF ZT 填五个字段     │
   │  ④点 Test 扫码验证 ──────────────────────────────────▶ 全链路生效
```

需要准备：

- 钉钉企业的**管理员**账号（能进[钉钉开发者后台](https://open-dev.dingtalk.com)）
- Cloudflare Zero Trust 团队域名（形如 `yourteam.cloudflareaccess.com`）
- 你在服务方的租户地址（形如 `{{TENANT_HOST}}`；从它打开 `/docs` 可看到填好真实值的文档）
