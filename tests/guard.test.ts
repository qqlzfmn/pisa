import { describe, expect, test } from "bun:test";
import { blockBash, outsideWorkdir } from "../extensions/guard";

const WORKDIR = "/work/repo";

const blocked = (cmd: string): string | null => blockBash(cmd, WORKDIR);

describe("blockBash · git push", () => {
  test("裸 push 拦截", () => {
    expect(blocked("git push")).toContain("push");
  });

  test("git 全局选项在子命令前也拦截", () => {
    expect(blocked("git -c user.name=x -c user.email=y push origin main")).toContain("push");
    expect(blocked("git --no-pager push origin main")).toContain("push");
    expect(blocked("git --paginate push")).toContain("push");
  });

  test("-C 指向 workdir 之外拦截", () => {
    expect(blocked("git -C /work/other push")).not.toBeNull();
    expect(blocked("git -C ../../main push")).not.toBeNull();
    expect(blocked("git --git-dir=/work/other/.git push")).not.toBeNull();
  });

  test("-C 指向 workdir 之内但仍是 push，拦截", () => {
    expect(blocked("git -C sub push")).toContain("push");
  });

  test("复合命令与包装命令不能绕过", () => {
    expect(blocked("cd sub && git push origin main")).toContain("push");
    expect(blocked("bun test; git push")).toContain("push");
    expect(blocked('bash -c "git push origin main"')).toContain("push");
    expect(blocked("echo $(git push)")).toContain("push");
  });
});

describe("blockBash · 仓库路径越界", () => {
  test("-C 指向 workdir 之外，非 push 也拦截", () => {
    expect(blocked("git -C /work/other status")).not.toBeNull();
    expect(blocked("git --work-tree=/work/other status")).not.toBeNull();
    expect(blocked("git -C .. status")).not.toBeNull();
    expect(blocked("git -C/work/other status")).not.toBeNull();
  });

  test("-C 在 workdir 之内放行", () => {
    expect(blocked("git -C sub status")).toBeNull();
    expect(blocked("git -C /work/repo status")).toBeNull();
  });
});

describe("blockBash · 分支与历史", () => {
  test("checkout / switch 分支拦截", () => {
    expect(blocked("git checkout main")).not.toBeNull();
    expect(blocked("git checkout -b feat")).not.toBeNull();
    expect(blocked("git switch main")).not.toBeNull();
    expect(blocked("git -c core.quotepath=false checkout main")).not.toBeNull();
  });

  test("checkout -- <path> 只恢复文件，放行", () => {
    expect(blocked("git checkout -- src/a.ts")).toBeNull();
  });

  test("worktree remove/prune 拦截，list 放行", () => {
    expect(blocked("git worktree remove .pisa/wt")).not.toBeNull();
    expect(blocked("git worktree prune")).not.toBeNull();
    expect(blocked("git worktree list")).toBeNull();
  });

  test("branch 删除拦截，列举放行", () => {
    expect(blocked("git branch -D feat")).not.toBeNull();
    expect(blocked("git branch -d feat")).not.toBeNull();
    expect(blocked("git branch")).toBeNull();
  });

  test("rebase 与 commit --amend 拦截", () => {
    expect(blocked("git rebase main")).not.toBeNull();
    expect(blocked("git -c user.name=p rebase --onto main")).not.toBeNull();
    expect(blocked("git commit --amend -m x")).not.toBeNull();
    expect(blocked("git commit -m 'feat: x'")).toBeNull();
  });

  test("reset --hard 与 clean -f 拦截，其它形态放行", () => {
    expect(blocked("git reset --hard HEAD")).not.toBeNull();
    expect(blocked("git -C sub reset --hard")).not.toBeNull();
    expect(blocked("git reset HEAD")).toBeNull();
    expect(blocked("git clean -fd")).not.toBeNull();
    expect(blocked("git clean --force")).not.toBeNull();
    expect(blocked("git clean -n")).toBeNull();
  });
});

describe("blockBash · 破坏性命令", () => {
  test("sudo 与根目录删除拦截", () => {
    expect(blocked("sudo rm -rf /tmp/x")).toContain("sudo");
    expect(blocked("rm -rf /")).not.toBeNull();
    expect(blocked("rm -rf /tmp/x")).toBeNull();
  });

  test("chmod/chown 作用于 /etc 拦截", () => {
    expect(blocked("chmod 777 /etc/passwd")).not.toBeNull();
    expect(blocked("chown -R me /etc/ssh")).not.toBeNull();
    expect(blocked("chmod +x scripts/a.sh")).toBeNull();
  });

  test("普通只读命令放行", () => {
    expect(blocked("ls -la")).toBeNull();
    expect(blocked("git status")).toBeNull();
    expect(blocked("git log --oneline -5")).toBeNull();
    expect(blocked("bun test")).toBeNull();
  });
});

describe("outsideWorkdir", () => {
  test("workdir 内放行", () => {
    expect(outsideWorkdir("/work/repo/a.ts", WORKDIR)).toBeNull();
    expect(outsideWorkdir("src/deep/b.ts", WORKDIR)).toBeNull();
    expect(outsideWorkdir("/work/repo", WORKDIR)).toBeNull();
  });

  test("workdir 外拦截", () => {
    expect(outsideWorkdir("/work/other/a.ts", WORKDIR)).not.toBeNull();
    expect(outsideWorkdir("../other/a.ts", WORKDIR)).not.toBeNull();
    expect(outsideWorkdir("/work/repo/../other", WORKDIR)).not.toBeNull();
    expect(outsideWorkdir("/etc/passwd", WORKDIR)).not.toBeNull();
    expect(outsideWorkdir("/work/repository/a.ts", WORKDIR)).not.toBeNull();
  });

  test("workdir 为空时拒绝并说明原因", () => {
    expect(outsideWorkdir("a.ts", "")).toContain("工作目录");
  });
});
