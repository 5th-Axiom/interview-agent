# IP 测试环境

## 当前部署

- SSH：`ssh cd`；项目目录 `/home/deploy/interview-agent`。
- 预定入口：`https://47.108.226.96:9443`；候选人 `/interview?entry=demo`，招聘方 `/admin/roles`。
- 2026-09-11：五个容器运行、迁移和种子完成，服务器内 HTTPS、鉴权和真实语音协议链路通过。外网 9443 尚不可达，须放行云安全组 / 上游入口的 TCP 9443 后再验收外网浏览器。IP 443 为已有 Aural 服务，未替换。
- 独立 Compose 名称 `interview-agent-staging`；数据库和对象存储无宿主端口，Web / Relay 仅绑定 `127.0.0.1:13100/13101`。不要对本项目执行 `down -v`，不要删除其他项目的卷。
- 真实供应商为 DeepSeek、DashScope、TokenDance；候选人使用显式开启的测试验证码 `123456`，没有发送真实短信。页面标识供应商联调及测试验证码。

## 登录与测试

入口参考 Alice 测试环境的账号密码表单和服务端 Cookie 机制，使用本项目独立测试账号。未登录不能访问业务页面、API 或 WebSocket；公开的 `/healthz` 只返回 `ok`。候选人 / 招聘方的业务权限仍独立校验。

1. 用分配的测试账号登录入口；原来的目标路径会保留。用户名和密码错误时返回通用提示，连续尝试会限流。
2. 候选人进入 `/interview?entry=demo`，填写明确的测试标识，先获取验证码，再输入 `123456`。授权麦克风，试音、选岗并回答，验证字幕、暂停恢复、结束和反馈。
3. 招聘方进入 `/admin/roles`，用独立管理员密码登录；检查岗位、试聊、发布入口，在面试记录中检查原文、录音、评估和重面审核。
4. 点击“退出测试环境”，测试入口、候选人和管理员 Cookie 一起清除；再次访问应回到入口登录。

账号交付文件为操作者本机 Git 忽略的 `.local/staging-login.txt`（0600）。远端只保存密码哈希，不保存入口或管理员明文密码。Cookie 为 HttpOnly / Secure / SameSite=Strict，7 天有效；修改测试用户名、密码哈希或签名密钥后旧入口 Cookie 失效。入口为单个共享测试账号，不是组织成员管理系统。

## 私有配置

`shared/app.env` 与 `shared/deploy.env` 均须为 0600，不提交仓库，不打印 `docker compose config` 或容器完整环境。应用镜像使用 UID 1000，须确保它能读取挂载的环境文件；文件只读挂载为 `/app/.env.local`。

`app.env` 以 `.env.example` 为键名依据，至少设置：

```dotenv
NODE_ENV=production
APP_ENV=staging
DEV_TEST_MODE=false
ALLOW_TEST_OTP=true
APP_URL=https://47.108.226.96:9443
NEXT_PUBLIC_RELAY_URL=wss://47.108.226.96:9443/ws
TEST_ACCESS_USERNAME=tester
```

另外必须设置独立的 `TEST_ACCESS_PASSWORD_HASH`、`ADMIN_PASSWORD_HASH`、`AUTH_SECRET`、`PHONE_HASH_SECRET`、数据库 URL、S3 配置与供应商凭据。两类密码均可通过标准输入交给 `node scripts/hash-admin.mjs` 生成 scrypt `salt:hash`，不要把明文放入命令行。只复制授权的语音供应商键，不复制参考项目的数据库或存储凭据。

`deploy.env` 需设置 `INTERVIEW_IMAGE`、`INTERVIEW_ENV_FILE`（绝对路径）、`INTERVIEW_DB_PASSWORD`、`INTERVIEW_STORAGE_USER`、`INTERVIEW_STORAGE_PASSWORD`；它们必须与应用配置一致。可设置 `POSTGRES_IMAGE` / `MINIO_IMAGE` 指定已验证的镜像版本。生产环境使用 `APP_ENV=production` 并关闭全部测试模式，配置真实短信。

## 构建、发布与回滚

在本地项目目录运行：

```bash
npm run deploy:staging
```

命令通过 `ssh cd` 将当前 Git 提交上传到独立 release 目录，在服务器构建带提交编号的镜像，执行迁移与幂等种子，更新 Web / Relay / Worker，等待容器健康，并检查可信 HTTPS、未登录页面跳转和 API 拒绝访问。成功后更新 `shared/deploy.env` 的镜像标签与 `current` 链接。源码由 `git archive HEAD` 打包；工作区有未提交内容时拒绝部署，服务器上的密钥和持久化数据继续复用。

只检查 SSH、Docker 和服务器配置、不部署：

```bash
npm run deploy:staging -- --check
```

该命令用于更新已经初始化的这台测试服务器；首次配置密钥、Nginx、证书及安全组仍按本文完成。它不修改 Nginx、证书、443 上的服务或云安全组，也不替你提交代码。项目级锁防止并发发布；失败返回非零并保留旧镜像与数据。若失败发生在替换容器之后，可能已有部分服务更新，须检查错误并按下面说明回滚应用；数据库迁移不会自动倒退。公网健康检查失败会单独提示，不把服务器内部通过误称为公网已通。

以下为手动操作和故障恢复命令：

在新 release 目录保存指定 Git 提交的源码；构建上下文排除密钥和本地结果。服务端示例：

```bash
docker build -f deploy/Dockerfile \
  --build-arg NEXT_PUBLIC_RELAY_URL=wss://47.108.226.96:9443/ws \
  -t interview-agent:<release> .
```

可用 `--build-arg NODE_IMAGE=<可信镜像仓库>/node:24-slim` 选择服务器可达的 Node 镜像。修改 `shared/deploy.env` 的 `INTERVIEW_IMAGE` 指向新标签，然后从 release 目录执行：

```bash
docker compose --env-file ../../shared/deploy.env -f deploy/compose.staging.yaml up -d postgres storage
docker compose --env-file ../../shared/deploy.env -f deploy/compose.staging.yaml run --rm web npm run db:migrate
docker compose --env-file ../../shared/deploy.env -f deploy/compose.staging.yaml run --rm web npm run db:seed
docker compose --env-file ../../shared/deploy.env -f deploy/compose.staging.yaml up -d
docker compose --env-file ../../shared/deploy.env -f deploy/compose.staging.yaml ps
```

从 `/home/deploy/interview-agent/releases/<release>` 到 shared 的相对路径为 `../../shared`。迁移与种子可重试；首部署时创建独立私有桶。发布会断开正在面试的连接，应避免在验收或面试中途重启。

回滚时将镜像标签改回保留的上一版本并重新 `up -d`。此方法仅适用于数据库迁移向后兼容的版本；涉及破坏性 schema 变更前须备份并评估恢复。环境文件、数据库卷和对象卷保留在 release 之外；不要使用全机 Docker 清理命令。

## IP HTTPS 与续期

当前证书为 Let's Encrypt 签发的可信 IP 证书，2026-09-11 首次签发、2026-09-17 到期。使用独立 Certbot 5.8 虚拟环境 `/opt/interview-certbot` 及配置目录，避免与其他站点或系统旧 Certbot 混用。

1. 将 `deploy/nginx.acme.conf` 安装为 `/etc/nginx/snippets/interview-agent-acme.conf`，在该 IP 的现有 80 端口 server 内 include；仅为 `/.well-known/acme-challenge/` 提供 `/var/www/interview-agent-acme` 文件。保留原业务路由，80 必须对外可达用于续期。
2. 首次签发：

```bash
sudo /opt/interview-certbot/bin/certbot certonly \
  --config-dir /etc/interview-agent/letsencrypt \
  --work-dir /var/lib/interview-agent-acme \
  --logs-dir /var/log/interview-agent-acme \
  --cert-name interview-agent-ip --ip-address 47.108.226.96 \
  --preferred-profile shortlived --webroot -w /var/www/interview-agent-acme \
  --agree-tos --non-interactive --register-unsafely-without-email
```

3. 安装 `deploy/nginx.staging.conf` 为 Nginx 站点并启用，`nginx -t` 后 reload。9443 的 Host 必须保留端口；`/ws` 单独反代 Relay。不要为部署便利覆盖已有 443 服务。
4. 将 `deploy/interview-agent-certbot.service`、`.timer` 安装到 `/etc/systemd/system/`，将 `deploy/reload-nginx.sh` 安装到 `/etc/interview-agent/reload-nginx.sh`（0755）。执行 `systemctl daemon-reload`、`systemctl enable --now interview-agent-certbot.timer`。每天两次检查续期，续期后检查并 reload Nginx。

检查 `systemctl list-timers interview-agent-certbot.timer`、`journalctl -u interview-agent-certbot.service`，并定期执行同一配置目录下的 `certbot renew --dry-run`。2026-09-11 已通过模拟续期。证书有效期短，不能关闭续期任务。证书私钥不进入应用容器或 Git。

## 验证边界

本次自动测试 26 项、类型检查、本地和 Linux 容器构建通过。服务器供应商检查与通过 SSH 通道的完整协议验收覆盖：匿名页面 / API / WebSocket 拒绝、错误与正确入口登录、招聘与候选人登录、真实 ASR / LLM / TTS、可靠结束、Worker 评估、私有录音生成和退出。协议验收使用合成 PCM 与模拟播放回执，不能代替外网浏览器实际播放或真人麦克风验收。

PC 1440px 浅色与 H5 390px 深色入口表单已通过真实 Chrome 截图检查，无横向溢出。另用 Chrome 经 SSH CONNECT 通道访问原始 IP HTTPS 地址，保留证书校验，实际从页面验证两端的匿名跳转、错误 / 正确密码、业务登录、退出与 Cookie 清除；浏览器确认安全上下文和麦克风 API 存在，无 JavaScript 异常。该检查不代表公网 9443 可达，也没有模拟真人麦克风。外网端口放行后仍需按上面的步骤检查实际麦克风和 WebSocket。
