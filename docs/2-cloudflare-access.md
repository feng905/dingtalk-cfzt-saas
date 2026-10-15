# 第 2 步：Cloudflare Zero Trust 配置（约 5 分钟）

前置：已完成[第 1 步](1-dingtalk-app.md)，且服务运营已给你开通租户，拿到 **client_id** 和 **client_secret**。

## 1. 添加 OIDC 登录方式

1. 打开 [Cloudflare Zero Trust 控制台](https://one.dash.cloudflare.com)，选择你的 team
2. **Integrations → Identity providers**（或 Settings → Authentication → Login methods，不同版本入口略有差异）
3. **Add new → 选 OpenID Connect**
4. 五个字段填写（把 `<slug>`、`<服务域名>` 换成运营给你的租户地址）：

| 字段 | 值 |
|---|---|
| **Name** | `DingTalk`（随意，显示在登录按钮上） |
| **Client ID** | 运营给的 client_id |
| **Client secret** | 运营给的 client_secret |
| **Auth URL** | `https://<slug>.sso.<服务域名>/authorize` |
| **Token URL** | `https://<slug>.sso.<服务域名>/token` |
| **Certificate URL** | `https://<slug>.sso.<服务域名>/jwks` |

5. **可选项全部保持默认**：
   - **PKCE 不要开**（本服务不支持，开了会登录失败）
   - SCIM 不要开
   - Scopes 保持默认 `openid email profile` 即可
6. **Save**

## 2. 点 Test 验证（真实扫码）

Login methods 列表里，新加的 DingTalk 旁边有 **Test** 按钮：

- 点它会弹浏览器窗口 → 出现钉钉扫码页 → 用**你企业成员**的钉钉 App 扫码确认
- 成功：显示 **"Your connection works!"**
- 失败：按页面报错查[排错对照表](3-troubleshooting.md)

## 3. 挂到应用

1. **Access → Applications** → 选你要保护的应用
2. 应用的 **Authentication / Login methods** 里勾选 **DingTalk**（原有的登录方式可以保留，登录页会出现多个入口）
3. 保存

## 4. 策略：放行哪些人

应用策略（Policies）里用**邮箱**控制放行。本服务给每个钉钉用户生成的登录身份邮箱规则（默认）：

```
<钉钉unionId>@dingtalk.local
```

常用写法：

| 想放行 | 策略 Include |
|---|---|
| 所有用钉钉登录进来的本企业成员 | Emails ending in → `@dingtalk.local` |
| 只放行指定同事 | Emails → 逐个填他们登录后的邮箱（可从 Access 日志里看到） |

> 如果运营给你的租户配置了「优先真实邮箱」模式，则邮箱是钉钉资料里的真实邮箱，策略按真实邮箱写。

## 5. 验证完成

无痕窗口访问受保护应用 → 登录页出现 DingTalk 按钮 → 扫码 → 进应用。收工。

企业成员以后登录只要：访问应用 → 扫钉钉 → 进。全程无密码。
