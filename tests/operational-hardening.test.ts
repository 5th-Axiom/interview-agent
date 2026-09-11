import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  mkdtemp,
  mkdir,
  writeFile,
  chmod,
  stat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { scryptSync } from "node:crypto";
test("setup repairs existing unsafe permissions; password hashing preserves intentional edge spaces", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "interview-setup-test-"));
  try {
    await mkdir(path.join(directory, "bin"));
    await writeFile(
      path.join(directory, ".env.local"),
      "AUTH_SECRET=fixture\nPHONE_HASH_SECRET=fixture\n",
    );
    await chmod(path.join(directory, ".env.local"), 0o644);
    await writeFile(
      path.join(directory, "setup.mjs"),
      await readFile(new URL("../scripts/setup.mjs", import.meta.url), "utf8"),
    );
    for (const command of ["docker", "npm"])
      await writeFile(
        path.join(directory, "bin", command),
        "#!/bin/sh\nexit 0\n",
        { mode: 0o755 },
      );
    const setup = spawnSync(
      process.execPath,
      [path.join(directory, "setup.mjs")],
      {
        cwd: directory,
        env: { PATH: path.join(directory, "bin"), NODE_ENV: "test" },
        encoding: "utf8",
      },
    );
    assert.equal(setup.status, 0, setup.stderr);
    assert.equal(
      (await stat(path.join(directory, ".env.local"))).mode & 0o777,
      0o600,
    );
    const password = "  fixture password  ";
    const result = spawnSync(
      process.execPath,
      [new URL("../scripts/hash-admin.mjs", import.meta.url).pathname],
      { input: password + "\n", encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const [salt, digest] = result.stdout.trim().split(":");
    assert.equal(scryptSync(password, salt, 64).toString("hex"), digest);
    assert.notEqual(
      scryptSync(password.trim(), salt, 64).toString("hex"),
      digest,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("deployment error reporting reaches a failing function without running deployment actions", async () => {
  const source = await readFile(
    new URL("../deploy/staging-release.sh", import.meta.url),
    "utf8",
  );
  const settings = source.split("\n").find((l) => l.startsWith("set -"))!;
  const trap = source.split("\n").find((l) => l.startsWith("trap "))!;
  const result = spawnSync(
    "bash",
    ["-c", `${settings}\n${trap}\ncompose(){ return 17; }\ncompose\n`],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 17);
  assert.match(result.stderr, /Deployment failed/);
});
