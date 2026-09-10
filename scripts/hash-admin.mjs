import { randomBytes, scryptSync } from "node:crypto";
// Read from stdin so the password does not enter shell history or process arguments.
let input = "";
for await (const part of process.stdin) input += part;
if (input.trim().length < 12)
  throw new Error("Use an admin password of at least 12 characters");
const salt = randomBytes(16).toString("hex");
console.log(`${salt}:${scryptSync(input.trim(), salt, 64).toString("hex")}`);
