---
name: AI 面试
description: 蓝色语音圆球与安静、清晰的中文招聘工作台
colors:
  bg-canvas: "#f5f7fa"
  bg-surface: "#ffffff"
  bg-subtle: "#eaf1fa"
  text-primary: "#182c46"
  text-secondary: "#576a80"
  action-primary: "#2466d8"
  action-hover: "#174ead"
  action-text: "#ffffff"
  border: "#dce3ec"
  danger: "#bd3c42"
  danger-bg: "#fff0ef"
  success: "#247457"
  focus: "#5189e4"
  orb-top: "#d8edff"
  orb-middle: "#70abf5"
  orb-bottom: "#386dce"
  dark-bg-canvas: "#111a27"
  dark-bg-surface: "#192638"
  dark-bg-subtle: "#21344c"
  dark-text-primary: "#e8eef8"
  dark-text-secondary: "#adbed4"
  dark-action-primary: "#83b2ff"
  dark-action-hover: "#afceff"
  dark-action-text: "#11294d"
  dark-border: "#33455c"
  dark-danger: "#ffa5a8"
  dark-danger-bg: "#3d252e"
  dark-success: "#80d3ac"
  dark-focus: "#a9cbff"
  dark-orb-top: "#accfff"
  dark-orb-middle: "#4d82cc"
  dark-orb-bottom: "#20477c"
typography:
  headline:
    fontSize: "32px"
    fontWeight: 650
    lineHeight: 1.3
    letterSpacing: "-0.025em"
  title:
    fontSize: "22px"
    fontWeight: 650
    lineHeight: 1.45
  body:
    fontFamily: 'Inter, "PingFang SC", "Microsoft YaHei", sans-serif'
    lineHeight: 1.65
rounded:
  control: "10px"
  panel: "16px"
  section: "12px"
  tag: "6px"
spacing:
  step-1: "4px"
  step-2: "8px"
  step-3: "12px"
  step-4: "16px"
  step-5: "24px"
  step-6: "32px"
  step-7: "48px"
  step-8: "64px"
components:
  button-primary:
    backgroundColor: "{colors.action-primary}"
    textColor: "{colors.action-text}"
    rounded: "{rounded.control}"
    padding: "10px 18px"
  button-primary-hover:
    backgroundColor: "{colors.action-hover}"
  button-default:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.text-primary}"
    rounded: "{rounded.control}"
  button-danger:
    backgroundColor: "{colors.danger-bg}"
    textColor: "{colors.danger}"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.text-secondary}"
  input:
    backgroundColor: "{colors.bg-surface}"
    textColor: "{colors.text-primary}"
    padding: "11px 13px"
    rounded: "{rounded.control}"
---
# Design System: AI 面试

## Overview

**Creative North Star: "蓝色语音圆球与安静的工作台"**

Operate 模式：沿用蓝色语音圆球与轻盈的中文工作台。候选人围绕声音状态和少量通话操作展开；招聘方围绕表单、列表、对话证据与复核展开。蓝色承担交互和语音身份，安静的中性表面承载内容。

**Key Characteristics:**

- 蓝色圆球是语音场景的识别核心。
- 中文系统字体、清晰层级、相关内容成组。
- 浅色与深色共享语义 Token，PC 与 H5 共用业务逻辑。

## Colors

蓝色主操作与冷灰中性色形成清晰、克制的层级。颜色规范提取自 `foundations/tokens.css`；以上 `dark-` 条目记录同一 CSS 语义变量在深色主题中的覆盖值，不是另一套业务 Token。

- Primary：action-primary 用于主要按钮、选中项及状态图标；action-hover 用于主要按钮悬停，action-text 保证按钮文字随主题切换。
- Neutral：bg-canvas 是页面底，bg-surface 是内容表面，bg-subtle 是提示与选中底；text-primary / secondary 区分正文和辅助信息，border 分隔内容。
- 状态：danger 与 danger-bg 表达错误和结束操作；success 表达已发布、已通过等状态。focus 专用于键盘焦点。
- 圆球：orb-top / middle / bottom 构成固定的蓝色径向渐变。浅深色均保持蓝色身份。

主题由根节点 data-theme 切换，appearance 保存到 localStorage；当前实现默认浅色，未实现自动跟随系统。

## Typography

使用现有 Inter、苹方、微软雅黑和 sans-serif 字体栈；不依赖外部字体下载。正文继承浏览器默认字号和 body 行高。页标题采用 headline，区块标题采用 title；管理界面正文通常为 14px，辅助标签为 12–13px。候选人主标题桌面为 28px、H5 为 24px；登录展示标题桌面为 40px、H5 为 27px。计时采用等宽数字特性，不使用另一种等宽字体。Prompt 文本域行高为 1.8，保留长文可读性。

## Layout

PC / H5 共用 React 组件和 Hook，通过 CSS 改变排列。候选人外层最大宽 1120px、语音主体最大宽 700px；岗位选择最大宽 490px，反馈最大宽 560px。桌面管理端使用 210px 侧栏，内容区最大宽 1450px；编辑表单与 320px 试聊侧栏并排。

- ≤1199px：管理侧栏缩为 180px，编辑与详情合为单列，试聊说明移到下方并隐藏其装饰圆球。
- ≤767px：顶栏高 64px、主要水平留白 20px；导航变为横排，表格变为带字段标签的纵向卡片；登录变为单列，操作允许换行。会话圆球从 220px 缩为 185px。
- 使用 svh 适配可视高度，候选人页脚处理底部安全区。保存操作条当前在正常文档流中，不是吸底悬浮栏。

## Elevation & Depth

内容表面主要依靠底色、细边框和留白分层，不依赖通用卡片阴影。圆球独有柔和外阴影和高光渐变，构成立体焦点；原生模态框使用半透明深色遮罩。

## Shapes

输入与按钮采用 control 圆角，登录面板与模态框采用 panel 圆角；内容区、岗位选项和表格容器使用 section 圆角。状态标签较紧凑。通话操作使用直径 62px 的圆形按钮，圆球保持正圆。

## Components

基础层提供 Button（默认、primary、danger、quiet）、Field、Notice、Dialog、Tag；业务层提供 Shell、VoiceOrb、VoicePanel。按钮默认最小高度 44px，表格紧凑按钮为 36px，反馈标签按钮为 38px；后两者是当前实现边界，不代表所有点击目标均达到 44px。

输入保留可见标签。通用 focus-visible 为 3px 焦点线、3px 偏移；禁用按钮降低透明度并禁止交互。Dialog 通过原生 showModal 打开，保留浏览器模态交互。导航以色彩、底色与字重标识当前页。

圆球本身 aria-hidden，由邻近 status 文字传达状态。说话与聆听使用 1.1s 音柱动画，思考使用 2s 呼吸，暂停与恢复降低饱和度；音量也可驱动行内缩放。prefers-reduced-motion 关闭 CSS 动画与过渡，但不关闭该行内音量缩放。不要将此文档视为完整无障碍合规声明。

## Do's and Don'ts

- 使用语义变量和基础组件扩展页面，保持 Foundations、基础组件、业务组件、页面四层；状态 Hook 和请求 api.ts 留在 features。
- 为图标操作提供可访问名称；视觉隐藏桌面文案后仍保留名称。状态以文字表达，错误使用 alert，常规反馈使用 status。
- 保持候选人界面聚焦语音；字幕默认隐藏，不引入阶段进度。
- 在 PC / H5、浅色 / 深色与键盘路径检查新增界面；测试模式继续明确标识。
- 不要在业务页面建立第二套颜色、字体或断点系统。
- 不要用圆球动画或颜色代替状态文字，也不要把演示输入当成真实语音能力。
- 不要把评估草稿表现为录用结论，或把体验评分表现为候选人成绩。
