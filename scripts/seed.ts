import { randomUUID } from "node:crypto";
import { pool, transaction } from "../server/db";
import { ensureBucket } from "../server/storage";
await transaction(async (db) => {
  await db.query(
    "INSERT INTO organizations VALUES('demo','第五公理 · 招聘团队') ON CONFLICT DO NOTHING",
  );
  await db.query(
    "INSERT INTO entries VALUES('demo','demo','第五公理 · AI 语音面试',true) ON CONFLICT DO NOTHING",
  );
  if ((await db.query("SELECT 1 FROM roles")).rowCount) return;
  for (const [name, description] of [
    ["前端工程师", "用清晰的技术表达，构建令人愉悦的产品体验。"],
    ["产品经理", "从真实用户问题出发，让想法成为有价值的产品。"],
    ["后端工程师", "设计可靠的服务，解决系统规模与复杂度的挑战。"],
  ]) {
    const id = randomUUID(),
      v = randomUUID();
    const prompt = `你是一位专业、友好的${name}面试官。先邀请候选人简单介绍自己，再围绕其真实项目经历自然追问。每次只问一个问题，了解决策过程、个人贡献、取舍和结果。避免重复问题，必要时解释问题。覆盖关键经历后邀请候选人提问，并自然收尾。全程用简洁中文交流，不评价录用结果。`;
    await db.query(
      "INSERT INTO roles(id,org_id,name,description,prompt) VALUES($1,$2,$3,$4,$5)",
      [id, "demo", name, description, prompt],
    );
    await db.query(
      "INSERT INTO role_versions(id,role_id,name,description,prompt) VALUES($1,$2,$3,$4,$5)",
      [v, id, name, description, prompt],
    );
    await db.query(
      "UPDATE roles SET published_version=$1,status='published' WHERE id=$2",
      [v, id],
    );
  }
});
await ensureBucket();
await pool.end();
console.log("Seed roles and private bucket ready");
