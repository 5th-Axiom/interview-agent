import { randomBytes, scryptSync } from "node:crypto";
// Read from stdin so the password does not enter shell history or process arguments.
let input = "";
for await (const part of process.stdin) input += part;
input = input.replace(/\r?\n$/, "");
if (input.length < 12)
  throw new Error("Use an admin password of at least 12 characters");
const salt = randomBytes(16).toString("hex");
console.log(`${salt}:${scryptSync(input, salt, 64).toString("hex")}`);
