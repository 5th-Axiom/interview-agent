# 整体改造核对表

由 `scripts/remediation-ledger.mjs` 从 JSON 生成。保留原始审查 ID；重复项共享修复，误报说明依据。状态不代表未知缺陷为零。

| ID | 项目 | 状态 | 处理与证据 |
|---|---|---|---|
| CR-F01 | 移动端操作区 safe-area 偏移 | 已修复 | 移除 H5 操作区相对定位的重复 safe-area 偏移，保留容器安全区。 app/globals.css；PC/H5 浏览器无横向溢出 |
| CR-F02 | 认证限流表超限会清空所有有效计数 | 已修复 | 按范围和身份摘要存 PostgreSQL 计数，过期行单独清理，不再清空全部计数。 server/rate-limit.ts；tests/remediation.test.ts：2001 个其他身份不能重置已限流身份 |
| CR-F03 | 测试登录限流容量满时误拦已有调用方 | 已修复 | 移除内存表容量导致的全局拒绝，复用持久化限流。 server/rate-limit.ts；tests/remediation.test.ts |
| CR-F04 | 验证文档测试数量不一致 | 不适用 | 26 与 28 对应不同日期/部署阶段，保留历史事实；本轮验收单独记录。 docs/verification.md |
| CR-F05 | 测试入口缺少防嵌入响应头 | 已修复 | 测试代理增加 DENY 和 CSP frame-ancestors，同时限制 base-uri/object-src。 deploy/nginx.staging-proxy.conf；配置检查，远端尚未发布 |
| CR-F06 | 测试入口遇到网关 HTML 错误时泄露解析错误到 UI | 已修复 | 共享响应解析保留 HTTP 状态，HTML 网关错误使用可重试的中文提示。 shared/http.ts；tests/remediation.test.ts |
| CR-F07 | 继续面试标签使用重复条件 | 已整理 | 重复条件属于可读性问题；继续按钮统一文案，保留显式恢复交互。 components/business/voice-panel.tsx；PC/H5 暂停与恢复检查 |
| CR-F08 | Relay 测试的管理员登录未传 admin 标志 | 不适用 | 管理员登录接口在业务 actor 分派前处理，不需要 admin 请求标志；未添加无意义标志。 app/api/[...path]/route.ts；scripts/relay-check.mjs 登录通过 |
| CR-F09 | setup 不会收紧已存在环境文件的权限 | 已修复 | setup 对已有 .env.local 同样收紧为 0600。 scripts/setup.mjs；tests/operational-hardening.test.ts 实际文件权限检查 |
| CR-F10 | H5 验收脚本收集到页面错误仍报 PASS | 已修复 | 页面异常列表必须为空才能通过。 scripts/mobile-check.mjs；Chrome H5 通过 |
| CR-F11 | 面试时长需要兜底非数值 | 已修复 | 计时显示对非有限数兜底为 0。 components/business/voice-panel.tsx |
| CR-F12 | 验收脚本对 event.text 使用 includes 缺少空值保护 | 不适用 | events.text 数据库 NOT NULL，当前验收读取该事件契约，不存在所述 nullable 路径。 migrations/001_initial.sql；scripts/journey-check.mjs |
| CR-F13 | PC 验收脚本收集到页面错误仍报 PASS | 已修复 | PC 页面异常不再只收集，必须断言为空。 scripts/browser-check.mjs；Chrome PC 通过 |
| CR-F14 | 保存复核意见按钮的禁用断言被丢弃 | 已修复 | 实际断言空复核意见的保存按钮禁用。 scripts/browser-check.mjs |
| CR-F15 | 测试环境变量未在失败时恢复 | 已修复 | 修改环境变量的测试使用 finally 还原。 tests/core.test.ts；npm test |
| CR-F16 | 候选人页面未防御 sessionStorage 不可用 | 已修复 | 浏览器存储失败不阻止候选人进入恢复界面。 features/interview/candidate-page.tsx |
| CR-F17 | 共享 API 遇到非 JSON 响应会丢失 HTTP 状态并误重试 | 已修复 | 非 JSON 响应保留状态码，按状态决定重试，避免把所有错误当网络异常。 shared/http.ts；tests/remediation.test.ts |
| CR-F18 | 输入手机号时应重置分页 | 不适用 | 手机号为草稿筛选，提交筛选时已经重置页码；逐键重置会改变既有交互。 features/admin/records-page.tsx；scripts/edge-check.mjs |
| CR-F19 | 部署测试依赖工作目录 | 已修复 | 部署验收用模块位置解析项目根路径。 tests/staging-command.test.ts；npm test |
| CR-F20 | 语音选岗播放失败后麦克风未恢复 | 已修复 | 选岗确认播放失败也在 finally 恢复采音并释放 AudioContext。 features/interview/use-role-selection.ts；scripts/mobile-check.mjs |
| CR-F21 | beforeunload 增加旧浏览器兼容写法 | 已修复 | beforeunload 同时设置 returnValue，未确认语音有离开提醒。 features/admin/use-unsaved-changes.ts；features/interview/use-voice-session.ts |
| CR-F22 | 短信调用持有数据库事务 | 已修复 | 短事务预留 OTP 发送令牌，HTTP 短信发送在事务外，按令牌确认成功/失败。 tests/sms.test.ts：12 个慢发送期间数据库仍可用，失败可立即重试 |
| CR-F23 | 候选人会话响应包含招聘方评估 Prompt | 已修复 | 候选人响应改为白名单 DTO，隐藏招聘评估要求。 server/business.ts；tests/remediation.test.ts 同时验证 bootstrap/snapshot |
| CR-F24 | ASR 保活异常逃逸并终止 Relay | 已修复 | ASR keepalive 异常进入恢复处理，不能逃出 interval 终止 Relay。 tests/asr.test.ts 注入发送异常 |
| CR-F25 | 助手音频落库零行时仍可能发送 | 已修复 | 生成音频先经有效代次/状态检查并写入 outbox，未落库行不发送。 server/audio-store.ts；tests/remediation.test.ts 错误 epoch 不产生可发送分片 |
| CR-F26 | 录音尾片 INSERT 缺少 ON CONFLICT | 已处理 | 原路径已有会话锁和去重；统一保存函数与锁顺序，内容寻址防覆盖，并验证重试内容/采集时间/代次。未机械添加掩盖冲突的 ON CONFLICT。 server/audio-store.ts；scripts/relay-check.mjs；tests/reliability.test.ts |
| CR-F27 | 录音整理内存和参数展开容量风险 | 已修复 | 录音用私有临时文件和有界分片窗口写入/上传，去掉全量缓冲和展开求最大值。 server/jobs.ts；server/storage.ts；Relay 私有录音 Range 验收 |
| CR-F28 | ASR 活动事件取消最终文本提交计时器 | 已修复 | activity 重排统一静音截止时间，pending final 不再永久悬挂。 tests/asr.test.ts：final 后 activity 且无新 final 仍提交 |
| CR-F29 | SSE 结束标记对空格格式过于严格 | 已修复 | SSE 支持 data 冒号后可选空白、EOF 和 DONE，DONE 后不继续解析。 tests/provider.test.ts 新增变体用例 |
| CR-F30 | 密码哈希脚本剥掉有效首尾空格 | 已修复 | 只去掉管道末尾换行，保留密码本身的首尾空格。 scripts/hash-admin.mjs；tests/operational-hardening.test.ts 实际 scrypt 校验 |
| C01 | 未确认音频满载后，继续面试会立即再次断开 | 已修复 | 8 秒积压时暂停采音；继续前先 HTTP 补传并清空旧队列，再连接和采音。 scripts/voice-recovery-browser.mjs：扣住回执直至满载后恢复通过 |
| C02 | 重新选岗会销毁尚未确认的保存队列 | 已修复 | 按会话保留未确认队列，换岗前同步，组件卸载不销毁待确认数据。 features/interview/pending-voice.ts；scripts/voice-recovery-browser.mjs |
| C03 | 旧连接的播放回执在重连后永久停止重试 | 已修复 | 保存源 epoch 与签名播放凭据，经历史连接授权通过 HTTP 跨连接补传。 server/audio-tail.ts；tests/remediation.test.ts |
| C04 | 播放进度和播放事件分开提交，重试无法修复中间失败 | 已修复 | 播放进度和事件在一个事务内提交，单调去重。 tests/remediation.test.ts：事件插入失败回滚进度，重试恰好一次 |
| C05 | 收尾等待数据库期间被打断，仍会结束面试 | 已修复 | 自然结束取得会话锁后再次检查回复代次和全部播放确认；取消失效不能结束。 tests/relay-runtime.test.ts：锁等待期间取消并确认 Relay 存活 |
| C06 | 已关闭连接的初始化仍可接管并踢掉新连接 | 已修复 | 初始化取得锁后、提交前检查 WebSocket 是否关闭，已关闭连接不接管。 tests/relay-runtime.test.ts：阻塞初始化后关闭，再连接成功 |
| C07 | 摘要提交与实时发言保存采用相反锁顺序 | 已修复 | Worker 与前台统一 sessions → jobs → 业务对象锁顺序。 server/job-lease.ts；tests/remediation.test.ts 并发争锁 |
| C08 | 续租语句允许已经过期的执行者复活租约 | 已修复 | 续租必须令牌匹配且租约尚未过期；失租任务中断。 tests/remediation.test.ts；tests/reliability.test.ts |
| C09 | 全局最大转写时间会跳过断线期间的中间录音缺口 | 已修复 | 逐音频片段记录转写覆盖，后段转写不会吞掉中间空洞。 server/jobs.ts；tests/remediation.test.ts |
| C10 | 录音整理将临时存储故障当成永久缺片完成任务 | 已修复 | 只有确定的对象 404 标记缺片，网络/服务故障交给有限重试；partial 可再整理。 server/storage.ts；server/jobs.ts；features/admin/record-detail.tsx |
| C11 | 保存成功回调会清除保存期间新增的人工编辑 | 已修复 | 保存成功仅清除对应提交版本，保存期间的新输入保留。 scripts/recovery-check.mjs：延迟响应后继续输入，成功及后台刷新均保留 |
| C12 | 取消后快速重录时，旧麦克风请求可覆盖新录音 | 已修复 | 每次录音与取消推进 generation，迟到 getUserMedia 不覆盖新录音并释放旧流。 features/interview/feedback-page.tsx；scripts/ui-edge-check.mjs 取消检查；Chrome 注入 A/B 授权乱序：旧 A 流关闭，B 保持录音，取消 B 后释放 |
| C13 | 候选人放弃反馈后，录过的语音仍向招聘方提供 | 已修复 | 反馈只关联最终提交的 audio_ids；跳过不会向招聘方提供曾录制但放弃的音频。 app/api/[...path]/route.ts；features/admin/record-detail.tsx；HTTP/UI 跳过验收 |
| C14 | 用户手动重试保存时会丢失原幂等请求编号 | 已修复 | 请求身份按路径和正文摘要保留，未知结果后手动重试复用原 UUID；成功后才开始新命令。 shared/pending-command.ts；tests/remediation.test.ts |
| C15 | 语义选岗没有把已接收的澄清历史传给模型 | 已修复 | 语义选岗实际使用有界澄清历史，测试模式和真实模式保持连续。 app/api/[...path]/route.ts；features/interview/use-role-selection.ts |
| C16 | 进入会话时丢失招聘入口，后续恢复和重面回到 demo | 已修复 | 会话地址、恢复、反馈和重面使用 entry_id，缺 URL 参数可由服务端会话恢复。 features/interview/candidate-page.tsx；features/interview/feedback-page.tsx；browser-check 支持 TEST_ENTRY；qa-campus 真实接口和 PC 浏览器完整流程通过 |
| C17 | 登录限流信任未经代理覆盖的 X-Forwarded-For | 已修复 | 不信任 X-Forwarded-For；仅显式 TRUST_PROXY 时读取由代理覆盖的 X-Real-IP。 server/rate-limit.ts；deploy/nginx.staging-proxy.conf；tests/remediation.test.ts |
| C18 | Relay 恢复测试发送了不符合契约的打断事件 | 已修复 | 删除格式不合法的空打断及其错误自动重问预期，加入真实响应编号的生命周期测试。 scripts/relay-check.mjs；tests/relay-runtime.test.ts |
| C19 | PC 和 H5 浏览器检查遇到页面异常仍报告 PASS | 已修复 | 同 CR-F10/F13，浏览器异常必须失败。 scripts/browser-check.mjs；scripts/mobile-check.mjs |
| C20 | 测试运行器继承部署 APP_ENV，破坏测试登录和环境断言 | 已修复 | 测试明确设置 APP_ENV=development，在唯一临时 schema 迁移，finally 只清理自己的 schema。 scripts/test.mjs；npm test |
| C21 | HTTP 控制未绑定版本，迟到旧命令可以改变接管后的会话 | 已修复 | HTTP 控制绑定版本/epoch；暂停、继续、换岗原子退休旧连接，旧请求不能改变新会话。 server/business.ts；tests/remediation.test.ts；scripts/mobile-check.mjs |
| H01 | Worker 失败状态原子提交 | 已修复 | 任务失败与评估等业务状态同事务，避免任务已失败但页面永久 running。 tests/remediation.test.ts 业务更新异常注入 |
| H02 | 部署脚本 ERR 继承 | 已修复 | 部署脚本 set -Eeuo pipefail，ERR trap 继承到函数。 tests/operational-hardening.test.ts |
| H03 | 缺失会话过期检查 | 已修复 | 过期处理先确认会话存在。 server/business.ts |
| P0-A1 | 采音、静音边界与连续性 | 工程完成 | Worklet 20ms 活动检测、80ms 持续确认、200ms PCM、静音 flush/ack 与输入缺口诊断；不把 RMS 视作已验证 VAD。 public/mic-worklet.js；scripts/mobile-check.mjs；真人回声验收见 QA-C |
| P0-A2 | 统一 ASR 静音与修订 | 工程完成 | 统一 900ms 静音目标，去掉应用端叠加等待；旧 ASR 只修订自身输入，静音 Finalize/有界静音推进。 server/asr.ts；tests/asr.test.ts；真实供应商 smoke |
| P0-B1 | 轮次与回复生命周期 | 工程完成 | 显式回复生命周期与输入修订，删除 5 秒无输入自动重生成。 server/turn-coordinator.ts；tests/relay-runtime.test.ts |
| P0-B2 | 控制与保存队列分离 | 工程完成 | 控制、ASR 输入和对象保存使用独立有界队列；本地立即停止声音。 server/relay.ts；tests/remediation.test.ts |
| P0-C1 | 实际对话投影 | 工程完成 | 修订替代原逻辑轮次；只把完整确认播放句子当作已听到；保留部分/未知状态。 server/conversation-view.ts；tests/remediation.test.ts |
| P0-C2 | 版本化 Prompt 与口语输出约束 | 工程完成，质量待盲评 | 平台 Prompt 版本化，纠正/澄清/拒绝展开规则和工具通道分离；朗读契约最多一次修复。 server/model.ts；server/spoken-output.ts；32 场景协议回放，模型质量见 EVAL |
| P1-A | 音频持久化 outbox 与归档 | 工程完成 | 助手 PCM 事务写 PostgreSQL outbox 再发送，Worker 有界合并归档，回放按对象字节范围读取。 migrations/005_voice_runtime.sql；server/audio-store.ts；持久化/录音测试 |
| P1-B | 有界 LLM/TTS 流水线 | 工程完成，性能待达标 | LLM/TTS 双队列上限 2 句/160 字，首包 160ms、后续 300ms，浏览器抖动缓冲 140ms。 server/relay.ts；server/tts.ts；tests/provider.test.ts；真实 TTS 首包 2525ms，不能宣称 1.8s 目标达标 |
| P1-C | 时长背压与跨连接补传 | 工程完成 | 服务端待播放时长 2.4 秒、浏览器队列 4 秒、未保存采音 8 秒；按签名凭据补传后再采音。 scripts/voice-recovery-browser.mjs；tests/remediation.test.ts |
| P2-A | Token 预算与后台摘要 | 工程完成 | 把 Prompt/工具/输出预留计入保守 Token 预算，65% 提前摘要，来源和版本 CAS，硬上限明确恢复。 server/context-budget.ts；server/context.ts；server/jobs.ts；tests/core.test.ts |
| P2-B | 长发言缓存与 CAS | 工程完成 | 长回答来源哈希/Prompt/模型签名缓存，后台分段摘要，实时路径不再同步压缩单条发言。 server/context.ts；server/jobs.ts；migrations/005_voice_runtime.sql |
| P2-C | 分用途模型与并发 | 工程完成 | 分用途模型/预算/并发配置，实时 8、摘要 1、评估 1；兼容 LLM_*。未擅自选择新模型。 server/runtime-profile.ts；server/model.ts；.env.example |
| OBS | 阶段遥测与管理端时间线 | 工程完成 | 保存阶段时序、安全字段、配置快照和请求编号，ping 校准记录偏差/误差；管理详情有时间线。 server/telemetry.ts；features/admin/record-detail.tsx；PC 详情检查；scripts/live-check.mjs：真实供应商浏览器 trace 验证全部关键阶段，零页面错误 |
| ROLLOUT | 冻结配置与回滚 | 本地实现，待发布 | 新会话冻结协议/开关/Prompt/实时模型配置，旧会话继续兼容；回滚只关闭新会话功能，保留 outbox Worker。 server/runtime-profile.ts；migrations/005_voice_runtime.sql；docs/remediation-report.md；本地迁移及服务重启完成；远端未发布 |
| EVAL | 30 个对话场景及模型对比 | 工具完成，待外部验收 | 32 个合成场景协议检查通过；真实模型对比脚本就绪，尚未指定候选模型，双人评分未完成。 scripts/evaluate-conversations.ts；tests/fixtures/conversation-cases.json；禁止把协议通过率当语义质量通过率 |
| QA-A | 自动化故障验收 | 已验证 | 事务故障、租约、锁竞争、ASR 乱序、真实 Relay 取消与关闭初始化等自动化验收。 npm test：48/48 |
| QA-B | PC/H5 浏览器验收 | 已验证 | PC/H5 Chrome 主流程、HTTP 边界、故障恢复、8 秒音频积压恢复、页面无异常/溢出。 browser/mobile/relay/edge/ui-edge/recovery/voice-recovery scripts |
| QA-C | 真实供应商、麦克风及双人盲评 | 部分验证，待外部验收 | 真实供应商 smoke 和浏览器全流程（合成麦克风）通过；100 有效轮次、30 插话、手机真机/人声、双人 >=95% 盲评和性能分位数未完成。 本轮合成输入报告；不以单次首包或模拟麦克风替代真人验收；scripts/journey-check.mjs：真实预览/语音/反馈转写/播放录音/评估重生成/重面，零 issues/errors |
