import { describe, expect, test } from "bun:test";
import {
  blockBash,
  outsideAllowed,
  parseCapabilities,
  isGuiTool,
  isWriteTool,
  type GuardCapabilities,
} from "../extensions/guard";

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

describe("outsideAllowed", () => {
  test("workdir 内放行", () => {
    expect(outsideAllowed("/work/repo/a.ts", WORKDIR)).toBeNull();
    expect(outsideAllowed("src/deep/b.ts", WORKDIR)).toBeNull();
    expect(outsideAllowed("/work/repo", WORKDIR)).toBeNull();
  });

  test("workdir 外拦截", () => {
    expect(outsideAllowed("/work/other/a.ts", WORKDIR)).not.toBeNull();
    expect(outsideAllowed("../other/a.ts", WORKDIR)).not.toBeNull();
    expect(outsideAllowed("/work/repo/../other", WORKDIR)).not.toBeNull();
    expect(outsideAllowed("/etc/passwd", WORKDIR)).not.toBeNull();
    expect(outsideAllowed("/work/repository/a.ts", WORKDIR)).not.toBeNull();
  });

  test("声明了额外根目录后按根目录放行", () => {
    expect(outsideAllowed("/data/shared/a.ts", WORKDIR, ["/data/shared"])).toBeNull();
    expect(outsideAllowed("/data/shared", WORKDIR, ["/data/shared"])).toBeNull();
    // 声明根目录后工作目录不再自动放行；清单生成时会把它并进去
    expect(outsideAllowed("src/a.ts", WORKDIR, ["/data/shared"])).not.toBeNull();
    expect(outsideAllowed("src/a.ts", WORKDIR, [WORKDIR, "/data/shared"])).toBeNull();
    expect(outsideAllowed("/data/other/a.ts", WORKDIR, ["/data/shared"])).not.toBeNull();
  });

  test("workdir 为空时拒绝并说明原因", () => {
    expect(outsideAllowed("a.ts", "")).toContain("工作目录");
  });
});

describe("parseCapabilities", () => {
  test("缺失或损坏按未声明处理", () => {
    expect(parseCapabilities(undefined)).toBeNull();
    expect(parseCapabilities("")).toBeNull();
    expect(parseCapabilities("{")).toBeNull();
  });

  test("只取认识的字段并补默认值", () => {
    expect(parseCapabilities('{"domains":["a.com","b.com"],"gui":true,"extra":1}')).toEqual({
      read: [],
      write: [],
      domains: ["a.com", "b.com"],
      gui: true,
      blocked: [],
    });
    expect(parseCapabilities('{"gui":"yes"}')?.gui).toBe(false);
  });
});

describe("能力清单 · 默认拒绝", () => {
  const caps: GuardCapabilities = { read: [], write: [], domains: [], gui: false, blocked: [] };
  const guarded = (cmd: string) => blockBash(cmd, WORKDIR, caps);

  test("未声明域名时禁止出网，含无法解析目标的形态", () => {
    expect(guarded("curl https://example.com/x")).toContain("域名");
    expect(guarded("curl -sS https://example.com")).toContain("域名");
    expect(guarded("wget -qO- https://example.com")).toContain("域名");
    expect(guarded("curl --version")).toContain("无法核对");
  });

  test("GUI 命令默认拒绝", () => {
    expect(guarded("open .")).toContain("GUI");
    expect(guarded("osascript -e 'tell app \"Finder\" to activate'")).toContain("GUI");
  });

  test("清单外的普通命令不受影响", () => {
    expect(guarded("ls -la")).toBeNull();
    expect(guarded("bun test")).toBeNull();
  });
});

describe("能力清单 · 显式放行", () => {
  const caps: GuardCapabilities = {
    read: [],
    write: [],
    domains: ["api.github.com", "raw.githubusercontent.com"],
    gui: true,
    blocked: ["docker"],
  };
  const guarded = (cmd: string) => blockBash(cmd, WORKDIR, caps);

  test("声明域名后只放行清单内目标", () => {
    expect(guarded("curl https://api.github.com/repos/x")).toBeNull();
    expect(guarded("curl -H 'accept: json' https://raw.githubusercontent.com/x/y")).toBeNull();
    expect(guarded("curl https://evil.com")).toContain("域名");
    expect(guarded("curl https://api.github.com.evil.com")).toContain("域名");
  });

  test("子域按后缀匹配，带端口也放行", () => {
    expect(guarded("curl https://api.github.com:443/x")).toBeNull();
    expect(guarded("curl https://gist.github.com/x")).toContain("域名");
  });

  test("gui=true 放行 GUI 命令与工具名", () => {
    expect(guarded("open .")).toBeNull();
    expect(isGuiTool("browser_click")).toBe(true);
    expect(isGuiTool("bash")).toBe(false);
  });

  test("追加禁令只拦指定命令名", () => {
    expect(guarded("docker ps")).toContain("docker");
    expect(guarded("env docker compose up")).toContain("docker");
    expect(guarded("docker-compose up")).toBeNull();
  });
});

describe("工具名分类", () => {
  test("写类工具覆盖常见命名，读类不误判", () => {
    for (const name of ["write", "edit", "write_file", "apply_patch", "create_directory", "move_file", "delete_file"]) {
      expect(isWriteTool(name)).toBe(true);
    }
    for (const name of ["read", "read_file", "bash", "grep", "glob"]) {
      expect(isWriteTool(name)).toBe(false);
    }
  });
});
