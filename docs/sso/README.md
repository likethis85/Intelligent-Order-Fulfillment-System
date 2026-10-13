# 智慧货盘选款系统 SSO 接入

接入日期：2026-10-13。使用 marius-sso 的服务端授权码流程，接入手册：<https://sso.marius.com.cn/guide>。

## 当前状态

本机代码接入、应用登记和自动化验收已完成。SSO 服务地址为 <https://sso.marius.com.cn>，现有应用凭证与两个本机回调均验证通过。项目登录界面：<http://127.0.0.1:3000/>。点击「钉钉登录」直接进入钉钉官方授权页，也可点击「统一账号登录」进入 SSO 登录页。SSO 管理后台口令仅用于管理应用，不能作为业务用户的登录账号。

钉钉平台域名已配置，授权请求的回调为 `https://sso.marius.com.cn/login/callback`。官方手机页面默认显示账号登录，可切换「扫码登录」。自动化验证入口和二维码显示；真实身份的扫码授权需要本人完成。

登录后触发的后端崩溃已修复，详细记录见 `backend-runtime-repair.md`。原有领猫数据源实测可读 331 款商品。本机尚未安装观远 BI 工具 `guancli`，BI 库存、画像和销量当前会报告读取失败；需要该工具和 BI 登录配置后才能恢复完整 BI 数据。

登记应用：智慧货盘选款系统；`client_id`：`app_8ad2f33624094db18b55`。

已登记的回调地址：

- `http://localhost:3000/api/auth/sso/callback`
- `http://127.0.0.1:3000/api/auth/sso/callback`

真实 SSO 的应用名、登录入口和客户端凭证检查已通过。真人账号完成登录尚待本人扫码或输入统一账号；自动化成功登录流程使用隔离的模拟身份源，未冒用真人身份。项目线上访问地址尚未提供，当前登记范围为本机开发。

## 实现行为

未登录时只显示登录入口，不挂载业务页面，也不请求货盘等业务接口。后端生成随机 `state`，绑定发起登录的浏览器，在回调时校验并一次性消费；后端调用 `POST /token` 换取身份，再签发随机、不透明的本项目会话 Cookie。

钉钉入口使用 `GET /api/auth/sso/start?provider=dingtalk`。由于 SSO 的 `provider` 参数目前不预选登录方式，项目后端先读取其授权页中登记的钉钉表单，再提交手册中的 `POST /authorize/{sid}/dingtalk`。只接受钉钉官方 HTTPS 授权地址、匹配的会话及当前 SSO 域名回调；连接失败或登录已取消时清理待处理状态并显示重试提示。该流程沿用既有回调和换码逻辑，密钥始终留在后端。

会话 Cookie 使用 `HttpOnly`、`SameSite=Lax`；HTTPS 环境使用 `Secure`。授权码、SSO 访问令牌与客户端密钥不进入前端脚本或浏览器存储。会话有效期不超过 SSO 令牌有效期。退出登录立即撤销本项目会话，同时关闭对应的协同连接；SSO 服务的其他应用会话由其各自管理。

业务 API、上传图片和 WebSocket 协同连接均要求有效登录。写操作与 WebSocket 连接校验登记的项目来源。协作姓名来自服务端确认的 SSO 身份，客户端自行填写的姓名不能覆盖操作记录中的身份。SSO 未配置时仍保持登录门禁。

保留现有货盘与配置规则，不新增角色分配规则。开发环境继续直连 3737 获取大响应；部署环境使用页面同源 API 与 WebSocket。图片导出与商品详情请求统一携带会话，Excel 导出仍包含图片。

## 配置与启动

原 `server/.env`、依赖声明、锁文件、Vite 配置与业务数据均未改动。新增的 `app/server/.env.sso` 保存本机真实客户端凭证，已有 `.gitignore` 的 `.env.*` 规则会忽略它；不要把该文件打包进前端或交付报告。无密钥示例为 `app/server/sso.env.example`。

后端启动时自动加载 `.env.sso`，进程环境变量优先。运行现有 `npm run dev` 即可。项目原有 Supabase 依赖需要 Node 22 或更新版本；本次使用临时目录中的 Node 22，未改系统 Node。当前机器可在 `app` 目录执行：

```powershell
$taskNodeDir = "$env:TEMP\marius-mobile-tools\node_modules\node\bin"
$env:PATH = "$taskNodeDir;$env:PATH"
npm run dev
```

前端端口为 3000，后端为 3737。首次使用其他电脑、局域网地址或线上域名时，需在 SSO 后台登记相应的完整回调地址，再设置该环境的 `SSO_REDIRECT_URI`；多个同协议地址可放入逗号分隔的 `SSO_REDIRECT_URIS`。

SSO 服务已使用 HTTPS。生产环境还需为货盘项目配置 HTTPS，设置 `NODE_ENV=production` 并登记项目的 HTTPS 回调。生产配置会拒绝 HTTP 或混用 HTTP / HTTPS 的回调地址。反向代理需转发 `/api`、`/uploads`，并支持 `/ws/trays` 的 WebSocket 升级；保留浏览器的 `Origin` 和 Cookie。

会话和待处理 `state` 存在当前 Node 进程内，重启后需重新登录。当前适用于单后端实例；多个实例需共享会话和 `state` 存储后再部署。

## 验证结果

| 检查 | 结果 |
| --- | --- |
| `npm run build` | TypeScript 与生产打包通过；原有大包提示仍存在 |
| 后端认证与运行环境测试 | 23 项通过：包含原有认证及真实后端路由在 BI 工具缺失时继续运行、商品同步与退出 |
| 浏览器验收 | 62 项通过；包含连接恢复后的登录提示清理；320 / 390 / 768 / 1440px 下双入口登录页与既有主要页面无全局横向溢出，无浏览器运行时异常 |
| 刷新、退出与过期 | 登录后刷新保持会话；退出或会话过期后返回登录页，业务接口拒绝访问 |
| Excel 图片导出 | 隔离样例成功导出，工作簿包含受保护的上传图和代理图 |
| 真实 SSO 登记 | 授权入口返回 200，应用名与两种登录方式正确；使用正确客户端凭证与无效测试码返回 `400 invalid_grant` |
| 钉钉与 HTTPS 域名 | 新域名健康检查、已登记的本机授权入口与既有客户端凭证通过；项目按钮直达官方授权页，扫码选项和二维码可显示，回调匹配新域名 |
| 配置与数据核对 | 原有 164 个文件中 16 个必要源码变化（包含 7 个 BI 客户端的崩溃修复），其余 148 个 SHA-256 一致；未改动现有配置、锁文件与业务数据 |
| 密钥保护 | 真实客户端密钥未出现在前端构建中；Vite 对 `.env.sso` 的直接访问返回 403 |
| Lint 差异 | 改动文件未新增 lint 问题；整库已有问题仍存在 |

浏览器验收使用独立上下文、模拟身份源与内存中的业务响应，写请求均被隔离，真实业务写入为 0。真实服务只验证登记凭证和登录入口，未完成真人登录或实际钉钉身份回调；线上部署、真实账号联调与多实例运行不在本次自动化验收范围内。

## 复现与交付文件

在 `app` 目录、Node 22 环境下执行：

```powershell
npm run build
node --test tests/sso-auth.test.mjs tests/backend-runtime.test.mjs
```

先按原命令启动前后端，再在项目根目录执行：

```powershell
node docs/sso/browser-check.mjs
```

浏览器脚本使用系统 Microsoft Edge 和项目已有的 Playwright / ExcelJS 依赖，不新增项目依赖。隔离测试不需要真人登录，真实入口检查需要提供的 SSO 服务可访问。

- `TODO.md`：已完成接入任务与实际账号、线上验收范围。
- `backend-runtime-repair.md`：登录后后端崩溃的原因、修复与本机 BI 依赖范围。
- `registration-check.json`：真实登记与凭证检查，不含密钥。
- `domain-check.json`：HTTPS 域名切换、既有凭证和钉钉入口的检查范围。
- `browser-results.json` / `browser-check.mjs`：浏览器检查结果与复现脚本。
- `audit-results.json` / `lint-diff.json`：原文件核对与 lint 差异。
- `login-390.png` / `login-1440.png`：手机与电脑上的本机登录页。
- `sso-entry-390.png` / `dingtalk-entry-390.png`：真实 SSO 入口与钉钉官方扫码页。
- `authenticated-390.png` / `authenticated-1440.png`：模拟账号与样例数据下的登录后界面。
