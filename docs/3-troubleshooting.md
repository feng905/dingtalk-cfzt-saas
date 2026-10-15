# 排错对照表

按登录链路顺序排列。先看现象，再按顺序排查。

## 钉钉侧

| 现象 | 原因 | 解决 |
|---|---|---|
| 扫码页报「重定向地址错误 / redirect uri 非法」 | 钉钉应用回调白名单没配或配错 | 核对白名单是否一字不差：`https://<slug>.sso.eastasia-gcr-nfr.cftenant.com/cb` |
| 扫码页提示「应用未上线 / 无权限」 | 应用没有发布版本 | 开发者后台 → 版本管理与发布 → 发布 |
| 扫码确认后提示拿不到用户信息 | 没开「通讯录个人信息读权限」 | 权限管理 → 开通 Contact.User.Read |
| 扫码后停在钉钉页没有跳转 | 回调地址网络不通（罕见） | 联系服务运营检查服务状态 |

## Cloudflare Access 侧

| 报错 | 含义 | 解决 |
|---|---|---|
| `Failed to fetch user/group information from the identity provider` | CF 调 token/userinfo 端点失败——**九成是五个字段里有 URL 填错** | 逐字核对 Auth/Token/Certificate 三个 URL（尤其结尾是 `/authorize` `/token` `/jwks`，没有尾斜杠） |
| `That account does not have access` | **认证已经成功**，是 Access 策略白名单没放行 | 应用 Policies → Include 加邮箱规则（见第 2 步文档第 4 节）；或先用 Everyone 验证链路再收紧 |
| `User email was not returned` | 不应出现（本服务保证返回 email）；出现即异常 | 重试一次；仍复现联系运营 |
| 登录页看不到 DingTalk 按钮 | 应用没勾选该登录方式 | 应用 Authentication/Login methods 勾选并保存 |
| Test 按钮一直转圈后超时 | CF 到服务的网络抖动 | 等 1 分钟重试；持续失败联系运营 |

## 服务侧（扫码后出现的英文错误页）

| 报错 | 含义 | 解决 |
|---|---|---|
| `organization not allowed for this tenant` | 你的钉钉组织不在租户的 corpId 白名单里 | 交企业 ID 给运营加入白名单（用 `["*"]` 模式开通的不会遇到） |
| `bad or expired state` | 授权会话超时（10 分钟有效期） | 回到应用入口重新发起登录 |
| `code already used` / `bad or expired code` | 授权码一次性且 2 分钟有效，刷新/回车重复提交导致 | 重新发起登录即可，非故障 |
| `redirect_uri not in allowlist` | CF 里的回调地址和租户登记的不一致 | 核对 CF IdP 配置与运营登记的团队域名 |

## 依然解决不了？

联系服务运营时请带上：

1. 哪一步、什么现象（截图最好）
2. 你的租户子域（如 `acme.sso.eastasia-gcr-nfr.cftenant.com`）
3. 大致时间点（运营可查该时间段的登录审计日志定位）
