import { existsSync } from "node:fs";
import { defaultRunner, prStatus, type Runner } from "./github";
import { sh } from "./git";
import type { RewindProbes } from "./rewind";

/** rewind 的三个只读探测点：预览与执行必须看到同一份状态，通道与 web 控制台共用 */
export function rewindProbes(runner: Runner = defaultRunner): RewindProbes {
  return {
    branchExists: (repoPath, branch) =>
      sh(["git", "-C", repoPath, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0,
    worktreeExists: (path) => existsSync(path),
    prState: (repo, n) => prStatus(runner, repo, n),
  };
}
