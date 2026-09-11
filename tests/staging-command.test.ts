import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "interview-deploy-"));
  for (const dir of ["scripts", "deploy", "bin", ".local"])
    mkdirSync(path.join(root, dir));
  for (const file of ["scripts/deploy-staging.sh", "deploy/staging-release.sh"])
    copyFileSync(file, path.join(root, file));
  writeFileSync(path.join(root, ".gitignore"), ".local/\n.env.local\nbin/\n");
  writeFileSync(
    path.join(root, ".env.local"),
    "PRIVATE_TOKEN=must-not-upload\n",
  );
  writeFileSync(path.join(root, ".local/private.txt"), "must-not-upload");
  writeFileSync(
    path.join(root, "bin/ssh"),
    `#!/usr/bin/env node
const fs = require('node:fs');
const payload = fs.readFileSync(0);
if (process.argv.some(arg => arg.includes('bash -s -- --check'))) {
  fs.writeFileSync(process.env.PREFLIGHT_MARKER, 'checked');
  process.exit(0);
}
fs.writeFileSync(process.env.UPLOADED_ARCHIVE, payload);
process.exit(17);
`,
    { mode: 0o755 },
  );
  const git = (...args: string[]) => {
    const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  git("init", "-q");
  git("add", ".");
  git(
    "-c",
    "user.name=Deployment Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const run = (...args: string[]) =>
    spawnSync("bash", ["scripts/deploy-staging.sh", ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: path.join(root, "bin") + path.delimiter + process.env.PATH,
        PREFLIGHT_MARKER: path.join(root, ".local/preflight"),
        UPLOADED_ARCHIVE: path.join(root, ".local/upload.tar"),
      },
    });
  return { root, run };
}

test("staging command rejects dirty work before SSH; check mode does not upload", () => {
  const { root, run } = fixture();
  try {
    writeFileSync(path.join(root, "uncommitted.txt"), "new work");
    const result = run();
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Commit or stash/);
    assert.throws(() => readFileSync(path.join(root, ".local/preflight")));
    assert.equal(run("--check").status, 0);
    assert.equal(
      readFileSync(path.join(root, ".local/preflight"), "utf8"),
      "checked",
    );
    assert.throws(() => readFileSync(path.join(root, ".local/upload.tar")));
    assert.equal(run("--unknown").status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("staging uploads only Git HEAD and propagates remote deployment failure", () => {
  const { root, run } = fixture();
  try {
    const result = run();
    assert.equal(result.status, 17);
    assert.doesNotMatch(result.stdout, /Deployed /);
    const archive = path.join(root, ".local/upload.tar");
    const listing = spawnSync("tar", ["-tf", archive], { encoding: "utf8" });
    assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /deploy\/staging-release.sh/);
    assert.doesNotMatch(listing.stdout, /\.env\.local|\.local\//);
    assert(!readFileSync(archive).includes(Buffer.from("must-not-upload")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
