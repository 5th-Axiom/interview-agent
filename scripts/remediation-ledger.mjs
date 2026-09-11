import fs from "node:fs";
const path = "docs/remediation-status.json";
if (!fs.existsSync(path)) {
  const cr = JSON.parse(
    fs.readFileSync(".local/coderabbit/full-findings-triaged.json"),
  );
  const cx = JSON.parse(
    fs.readFileSync(".local/codex-blind/codex-triaged.json"),
  );
  const extra = {
    H01: "Worker 失败状态原子提交",
    H02: "部署脚本 ERR 继承",
    H03: "缺失会话过期检查",
    "P0-A1": "采音、静音边界与连续性",
    "P0-A2": "统一 ASR 静音与修订",
    "P0-B1": "轮次与回复生命周期",
    "P0-B2": "控制与保存队列分离",
    "P0-C1": "实际对话投影",
    "P0-C2": "版本化 Prompt 与口语输出约束",
    "P1-A": "音频持久化 outbox 与归档",
    "P1-B": "有界 LLM/TTS 流水线",
    "P1-C": "时长背压与跨连接补传",
    "P2-A": "Token 预算与后台摘要",
    "P2-B": "长发言缓存与 CAS",
    "P2-C": "分用途模型与并发",
    OBS: "阶段遥测与管理端时间线",
    ROLLOUT: "冻结配置与回滚",
    EVAL: "30 个对话场景及模型对比",
    "QA-A": "自动化故障验收",
    "QA-B": "PC/H5 浏览器验收",
    "QA-C": "真实供应商、麦克风及双人盲评",
  };
  const items = [
    ...cr.map((x) => ({ id: `CR-${x.id}`, title: x.title })),
    ...cx.map((x) => ({ id: x.id, title: x.title })),
    ...Object.entries(extra).map(([id, title]) => ({ id, title })),
  ].map((x) => ({ ...x, status: "open", resolution: "", validation: [] }));
  fs.writeFileSync(
    path,
    JSON.stringify(
      { baseline: "68dfe808c46a1142af0a2a8df5a8cfaa79dfd142", items },
      null,
      2,
    ) + "\n",
  );
}
const data = JSON.parse(fs.readFileSync(path));
fs.writeFileSync(
  "docs/remediation-status.md",
  "# 整体改造核对表\n\n由 `scripts/remediation-ledger.mjs` 从 JSON 生成。保留原始审查 ID；重复项共享修复，误报说明依据。状态不代表未知缺陷为零。\n\n| ID | 项目 | 状态 | 处理与证据 |\n|---|---|---|---|\n" +
    data.items
      .map(
        (x) =>
          `| ${x.id} | ${x.title} | ${x.status} | ${(x.resolution + " " + x.validation.join("；")).replaceAll("|", "/").replaceAll("\n", " ")} |`,
      )
      .join("\n") +
    "\n",
);
