import { describe, expect, test } from "bun:test";
import { blockBash, outsidePath, outsideWorkdir, type GuardCapabilities } from "../extensions/guard";

const WORKDIR = "/work/repo";

const blocked = (cmd: string): string | null => blockBash(cmd, WORKDIR);

const CAPS: GuardCapabilities = {
  readDirs: [WORKDIR, "/tmp", "/data/fixtures"],
  writeDirs: [WORKDIR, "/tmp", "/data/out"],
  domains: ["example.com"],
  gui: true,
  blocked: ["npm publish"],
};

const allowed = (cmd: string): string | null => blockBash(cmd, WORKDIR, CAPS);

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

describe("blockBash · 能力默认拒绝", () => {
  test("网络、GUI、目录外读取与写入都拦截", () => {
    expect(blocked("curl https://example.com")).toContain("域名未放行");
    expect(blocked("ssh root@example.com")).toContain("域名未放行");
    expect(blocked("open -a Safari")).toContain("图形界面未放行");
    expect(blocked("osascript -e 'tell app Finder to activate'")).toContain("图形界面未放行");
    expect(blocked("cat /etc/passwd")).toContain("路径不在允许目录内");
    expect(blocked("grep root /etc/passwd")).toContain("路径不在允许目录内");
    expect(blocked("echo x > /Users/lzf/a.ts")).toContain("路径不在允许目录内");
    expect(blocked("tee /Users/lzf/a.ts")).toContain("路径不在允许目录内");
    expect(blocked("cp src/a.ts /Users/lzf/a.ts")).toContain("路径不在允许目录内");
  });

  test("工作目录与临时目录仍可读写", () => {
    expect(blocked("cat src/a.ts")).toBeNull();
    expect(blocked("echo x > /tmp/pisa-cap.txt")).toBeNull();
    expect(blocked("rm -rf /tmp/pisa-cap")).toBeNull();
    expect(blocked("touch src/new.ts")).toBeNull();
  });
});

describe("blockBash · 能力显式放行", () => {
  test("声明的域名放行，其它域名仍拒绝", () => {
    expect(allowed("curl https://example.com/a")).toBeNull();
    expect(allowed("curl -o out.txt https://example.com/a")).toBeNull();
    expect(allowed("git clone https://example.com/foo/bar")).toBeNull();
    expect(allowed("curl https://other.com")).toContain("域名未放行");
    expect(allowed("git clone https://other.com/foo/bar")).toContain("域名未放行");
  });

  test("GUI 开关单独生效", () => {
    expect(allowed("open -a Safari")).toBeNull();
    expect(allowed("osascript -e 'tell app Finder to activate'")).toBeNull();
  });

  test("可读目录放行，其它绝对路径仍拒绝", () => {
    expect(allowed("cat /data/fixtures/a.json")).toBeNull();
    expect(allowed("head -n 5 /data/fixtures/a.json")).toBeNull();
    expect(allowed("cat /etc/passwd")).toContain("路径不在允许目录内");
  });

  test("可写目录放行，目录外写入仍拒绝", () => {
    expect(allowed("echo x > /data/out/a.txt")).toBeNull();
    expect(allowed("echo x >/data/out/a.txt")).toBeNull();
    expect(allowed("mkdir -p /data/out/nested")).toBeNull();
    expect(allowed("cp /data/fixtures/a.json /data/out/a.json")).toBeNull();
    expect(allowed("echo x > /data/other/a.txt")).toContain("路径不在允许目录内");
    expect(allowed("cp /data/fixtures/a.json /data/other/a.json")).toContain("路径不在允许目录内");
  });

  test("切换目录不能绕过读目录边界", () => {
    expect(allowed("cd /data/fixtures && ls")).toBeNull();
    expect(allowed("cd /etc && cat passwd")).toContain("路径不在允许目录内");
    expect(allowed("pushd /etc")).toContain("路径不在允许目录内");
  });

  test("额外拒绝按命令前缀匹配", () => {
    expect(allowed("npm publish --tag next")).toContain("npm publish");
    expect(allowed("npm run build")).toBeNull();
  });
});

describe("outsidePath", () => {
  test("读目录与写目录分别判定", () => {
    expect(outsidePath("/data/fixtures/a.json", WORKDIR, CAPS.readDirs)).toBeNull();
    expect(outsidePath("/data/fixtures/a.json", WORKDIR, CAPS.writeDirs)).not.toBeNull();
    expect(outsidePath("/data/out/a.json", WORKDIR, CAPS.writeDirs)).toBeNull();
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
