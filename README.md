# Interview Agent

可运行的 AI 语音面试网站，包含候选人与招聘方两端。React / TypeScript / Next.js、独立 PostgreSQL、私有 S3 兼容存储、常驻 WebSocket Relay 和 Worker 共用一套工程。

当前本地运行在**真实供应商联调模式**：DeepSeek 对话 / 评估、DashScope 流式识别、TokenDance 流式语音合成已通过真实请求和 Chrome 合成麦克风端到端检查。凭据已按授权从只读参考项目复制到被 Git 忽略的 `.env.local`。短信仍使用明确开启的测试验证码；没有宣称完成真人手机、正式短信或生产容量验收。完整结果见 [验证记录](docs/verification.md)。

## 本地启动

需要 Node.js 22+、npm、Docker Desktop（已启动）。本次使用 Node.js 26.3.0 验证，依赖版本锁定在 package-lock.json。

```bash
npm ci
npm run setup
npm run dev:all
```

`setup` 在没有配置时从 `.env.example` 创建 `.env.local`，为初始占位密钥生成随机值；启动本项目 Compose，执行版本化迁移，创建私有桶和三个示例岗位。重复运行保留现有数据。不要在真实数据已经存在后更换手机号检索密钥。

- 候选人入口：[http://localhost:3100/interview?entry=demo](http://localhost:3100/interview?entry=demo)
- 招聘工作台：[http://localhost:3100/admin/roles](http://localhost:3100/admin/roles)
- Relay 健康检查：[http://localhost:3101](http://localhost:3101)
- 本地 PostgreSQL：`localhost:55432`，数据库 `interview_agent`
- 本地 MinIO：`localhost:59000`，控制台 `localhost:59001`，桶 `interview-agent-private`

候选人可填写任意测试标识，例如 `candidate-demo`，**先获取验证码，再输入 `123456`**。验证码有效期 5 分钟，60 秒重发冷却，最多 5 次错误尝试。招聘方开发密码为 `.env.local` 中的 `DEV_ADMIN_PASSWORD`（示例 `local-recruiter`）。两端使用独立 HttpOnly Cookie。

当前联调模式可授权真实麦克风，与真实 AI 语音交流。页面顶部明确标记“供应商联调环境 / 测试验证码”。

`.env.example` 默认是离线测试模式；没有供应商凭据时用 `npm run dev:test` 启动：可点击“开发测试：跳过麦克风，使用文字输入”，文字替代 ASR，TTS 为静音 PCM，字幕展示固定测试回复。两种语音模式与测试登录开关独立，生产拒绝任何测试登录 / 对话配置。每场会话冻结 `test_mode`，切换运行配置不会把旧测试评估伪装成真实评估。

可分别运行：

```bash
npm run dev
npm run relay
npm run worker
```

后端修改后重启 Relay / Worker。Web 开发服务器热更新。停止本项目进程用 Ctrl+C；停止独立数据库和存储用 `docker compose stop`，数据保留在 `interview-agent_*` 命名卷。所有脚本均不操作参考仓库或其他项目数据。

## 已实现的链路

**候选人**：招聘入口登录、麦克风试音和重试、点击岗位直接开场、语音意向识别接口、默认隐藏字幕、静音、暂停与恢复、重新选岗、确认结束、结束反馈与独立语音说明、再次面试申请（原因选填）。反馈标签与 PRD 一致，最多 500 字，超限保留输入，跳过前确认放弃。原会话刷新续接，过期进入反馈。语音选择在准备阶段按短片段识别后由模型调用选岗工具；正式面试使用持续流式 ASR。

**招聘方**：岗位搜索和状态筛选、草稿编辑、不可变发布版本、停用、复制入口；未发布配置的独立试聊；按手机号、岗位、日期和状态查记录；查看原始对话、播放录音、修改本次评估要求并重新生成、查看历史评估、独立保存人工意见、审核重面申请。记录每页 50 条，岗位筛选包括历史片段；评估要求可单独保存 / 取消，重新生成需确认，失败继续展示旧草稿。

**可靠性**：会话与请求的数据库唯一约束及事务；首次选岗才设置一小时截止并消费重面资格；暂停、断线、换岗不延长截止；心跳单独累计有效时长；显式连接接管；`connection_epoch` / `response_id` 贯穿异步链路；本地停声与 LLM/TTS 同时取消；固定消息批次、落库回执和有限缓冲；录音边采边存、实际播放起点和部分确认、补传不重新触发 ASR；原始事件追加、带来源的原子摘要版本、评估引用校验。Worker 独立监督到期结束，处理摘要、尾部补转写、评估、录音和失败重试；租约 token 校验阻止旧执行者写回。结束后 30 秒内接收当前连接在截止前采集的未确认尾片，后台补转写只进入原文核对，不触发实时对答。

## 真实供应商配置

语音联调设置 `DEV_TEST_MODE=false`。本地没有短信服务时可保留 `ALLOW_TEST_OTP=true`，页面明确展示测试登录；正式部署必须设为 `false`。填写与所选供应商对应的配置：

| 配置                                                                    | 用途                                                                                                     |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `LLM_BASE_URL` / `LLM_API_KEY` / `LLM_MODEL`                            | Chat Completions 兼容接口，必须支持 SSE 与 function tools；模型名称显式配置                              |
| `LLM_FALLBACK_BASE_URL` / `LLM_FALLBACK_API_KEY` / `LLM_FALLBACK_MODEL` | 可选备用模型；上下文和工具契约相同；首段输出后不切换或整轮重播                                           |
| `TTS_PROVIDER`                                                          | `tokendance` 或 `openai`；合成流统一为 24kHz PCM16                                                       |
| `TOKENDANCE_API_KEY` / `TTS_RESOURCE_ID` / `TTS_VOICE`                  | TokenDance Seed TTS 流式接口；当前资源 `seed-tts-2.0`，中文声音 `zh_female_shuangkuaisisi_uranus_bigtts` |
| `ASR_PROVIDER`                                                          | `dashscope` 或 `deepgram`                                                                                |
| `DASHSCOPE_API_KEY` / `DASHSCOPE_ASR_MODEL` / `DASHSCOPE_ASR_WS_URL`    | DashScope 流式任务；当前模型 `qwen-audio-3.0-asr-flash-streaming`，显式等待 task-started                 |
| `TTS_BASE_URL` / `TTS_API_KEY` / `TTS_MODEL` / `TTS_VOICE`              | `/audio/speech`，逐句请求，24kHz PCM16 单声道                                                            |
| `DEEPGRAM_API_KEY` / `DEEPGRAM_MODEL`                                   | Deepgram 流式识别，16kHz PCM16；默认配置 `nova-3` / `zh`                                                 |
| `SMS_URL` / `SMS_TOKEN`                                                 | 短信 HTTP 网关；见下方契约，尚未接入客户的真实短信服务                                                   |
| `AUTH_SECRET` / `PHONE_HASH_SECRET`                                     | 独立、稳定的 32 字符以上服务端密钥；不提交 Git                                                           |
| `ADMIN_PASSWORD_HASH`                                                   | 本期工作台管理员口令的 scrypt 校验值；正式组织身份提供方仍待接入                                         |
| `DATABASE_URL` / `S3_*`                                                 | 本项目专用 PostgreSQL 和私有桶，不允许公共访问策略                                                       |
| `APP_URL` / `NEXT_PUBLIC_RELAY_URL`                                     | 对外 HTTPS / WSS 地址；必须与浏览器使用的入口一致                                                        |

短信网关接收 `POST` JSON `{ "phone": "...", "code": "..." }`，使用 `Authorization: Bearer <SMS_TOKEN>`，发送成功返回 2xx。网关应负责供应商模板、签名、实际投递和供应商限流。这是已实现的可配置网关适配接口，**不是已完成阿里云 / 腾讯云短信账号接入**。

生产管理员口令可以通过标准输入传给 `node scripts/hash-admin.mjs` 生成 `salt:hash`；不要将原始口令写入命令行参数或 Git。当前实现是单组织工作台口令登录，尚未对接客户 SSO / OIDC 和成员管理。服务端组织范围校验仍然强制执行。

供应商协议依据：[Chat Completions](https://developers.openai.com/api/reference/resources/chat)、[Speech](https://developers.openai.com/api/reference/resources/audio/subresources/speech/methods/create)、[Deepgram Streaming](https://developers.deepgram.com/reference/speech-to-text/listen-streaming)、[Deepgram 模型与语言](https://developers.deepgram.com/docs/models-languages-overview)。另参考 [DashScope 客户端事件](https://help.aliyun.com/en/model-studio/fun-asr-client-events)。当前 DeepSeek / DashScope / TokenDance 已实际调用；OpenAI / Deepgram 备用接口用协议替身覆盖，未用其真实账号验证。

## 生产启动与部署

```bash
npm run build
npm start
# 分别在两个常驻进程中运行，环境变量必须为正式配置：
NODE_ENV=production npm run relay
NODE_ENV=production npm run worker
```

`npm start` 会在启动 Web 之前验证生产环境：开启测试模式或固定 OTP 会直接拒绝启动，缺少供应商及正式登录配置会报错。默认开发 `.env.local` 下的 `npm start` **应当失败**，本地检查请用 `npm run dev:all`。

参考 [Caddy 配置](deploy/Caddyfile.example) 使用同域 `/ws` 反代 Relay。设置 `APP_URL=https://你的域名`、`NEXT_PUBLIC_RELAY_URL=wss://你的域名/ws` 后重新构建。麦克风在 localhost 或 HTTPS 安全上下文中使用；真正手机检查需 HTTPS 域名，不能把 `localhost` 当手机可达地址。

不要记录请求 Cookie、Authorization、音频内容或播放 URL 查询参数。Next 请求日志已关闭；部署侧也要避免把短期播放票据写入访问日志。录音通过登录权限和 5 分钟签名票据代理，支持 HTTP Range；S3 对象不公开。

## 验证

```bash
npm run typecheck
npm test
npm run build
# 先启动 Web / Relay / Worker；浏览器脚本默认使用本机 Google Chrome：
npm run test:relay
npm run test:browser
npm run test:mobile
npm run test:edges
# 真实供应商检查：先启用真实模式并启动服务
npm run test:providers
npm run test:live
npm run test:ui-edges
npm run test:context-live
npm run test:selection-live
npm run test:journey
npm run test:recovery
```

`npm test` 自动建立独立 `interview_agent_test` 数据库并迁移，不清空开发库。23 项测试覆盖真实数据库事务、OTP、安全配置、摘要、评估、SSE 分包、备用模型、取消、分阶段工具权限及模拟流式 ASR 的修订与轮换。供应商协议测试使用本地 HTTP / WebSocket 服务器。

`test:browser` / `test:mobile` / `test:relay` 使用 `npm run dev:test` 对应的明确测试语音服务；`test:live` 使用当前真实供应商服务，并需要 `test:providers` 生成的合成音频。不要在同一端口同时启动两套服务。

`test:journey` 在真实供应商模式下通过页面完成创建岗位、试聊、发布、候选人面试及反馈、录音播放、重新评估、人工复核、重面拒绝与通过、新一轮资格消费、草稿隔离与停用；同样先运行 `test:providers`。成功后停用本次创建的验收岗位，保留验证记录。`test:recovery` 用明确的 HTTP / 麦克风权限故障注入检查错误提示、输入保留及重试，需要 `test:live` 的已完成记录。

浏览器脚本创建明确的测试账号和测试记录；截图与结果保存在 `.local/`（不提交 Git）。`test:mobile` 在真实 Chrome 中模拟 390px H5 视口和 44.1kHz 麦克风音频，验证 AudioWorklet 及业务交互；它不等于 iOS / Android 真机或真实人声识别验收。

## 代码结构

- `foundations/`：浅深色语义 Token；[设计系统](DESIGN.md)
- `components/base/`、`components/business/`、`app/`：基础组件、业务组件、页面四层
- `features/`：页面 Hook 与 `api.ts`，没有 Controller / Port 层
- `server/`：共享鉴权、事务、会话、供应商、上下文、存储；Relay / Worker 两个常驻入口
- `shared/`：Zod 实时契约和取消 / 保存队列逻辑
- `migrations/`、`scripts/`、`tests/`：迁移、种子、启动和验证

[PRD](docs/prd.md)、[技术方案](docs/technical-plan.md)、[实施说明](docs/implementation-brief.md) 保留产品依据；[实现与验证边界](docs/verification.md) 记录当前工程现状。两个参考仓库仅供只读分析；本次没有复制其源码，因此没有引入需重新分发的参考代码片段。
