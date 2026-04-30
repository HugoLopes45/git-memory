// Test helper: provision a throwaway git repo. No bootstrap needed —
// mneo v2 has no init step; first record creates its own ref.

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempRepo {
  repo: string;
  cleanup: () => void;
}

export function makeTempRepo(): TempRepo {
  const repo = mkdtempSync(join(tmpdir(), "mneo-test-"));
  const init = spawnSync("git", ["-C", repo, "init", "--initial-branch=main", "--quiet"], {
    encoding: "utf8",
  });
  if (init.status !== 0) throw new Error(`git init failed: ${init.stderr}`);
  spawnSync("git", ["-C", repo, "config", "user.name", "mneo-test"]);
  spawnSync("git", ["-C", repo, "config", "user.email", "test@mneo"]);
  return {
    repo,
    cleanup: () => rmSync(repo, { recursive: true, force: true }),
  };
}
