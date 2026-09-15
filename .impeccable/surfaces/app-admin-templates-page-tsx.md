---
version: 1
slug: "app-admin-templates-page-tsx"
primary_target: "app/admin/templates/page.tsx"
related_targets: ["features/admin/templates-page.tsx", "features/admin/template-browser.tsx", "features/admin/template-picker.tsx", "features/admin/prompt-templates.ts", "features/admin/role-editor.tsx", "app/globals.css"]
---

# Prompt 模板

## Overview

招聘方按面试方式选择完整 Prompt，阅读、复制或用于创建岗位；编辑器内复用相同选择器。沿用根 DESIGN.md 的中文蓝色工作台与现有浅深色 Token。

## Layout

PC 使用 255px 目录和剩余宽度的模板内容，间距 32px。目录提供面试方式筛选和模板名称列表。详情展示名称、用途说明、主要操作和默认展开的完整 Prompt。Prompt 使用原始文本与换行，正文字体、14px 字号，长文本自动折行；不另行解析阶段、问题或大纲。

H5 在 767px 断点改为上下排列；模板选项宽 225px，可横向滚动，完整文本随页面纵向阅读。选择弹窗复用目录与详情，PC 左右分隔、H5 上下分隔。保留右上角关闭和底部取消入口。

## Components

- 页面与选择器直接展示模板的 `prompt` 字符串，复制和应用使用同一文本。
- 类型只有目录筛选作用，统一为固定问题、主题引导、开放访谈三类，共 5 份模板；下拉选项显示各类数量。软件测试场景推演和通用岗位简短初筛是主题引导下的示例，提问与收尾行为全部写在 Prompt 中。
- 已有内容时确认替换，仅补全空白岗位名称与简介；选用不自动保存或发布。
- 继承现有 Button、Dialog、Notice、aria-pressed、aria-current 和 focus-visible。

## Do's and Don'ts

- 2026-09-15 用户明确要求删除独立面试计划展示，同时删除阶段题数与建议时长统计；不保留另一套结构化计划配置或自动摘要。
- 允许明确计划写在 Prompt 文本中，也允许没有预设计划的自然访谈。
- 不将目录尺寸或本页构图升格为全局规范，不修改根设计 Token。
