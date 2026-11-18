import { describe, expect, test } from "bun:test";
import { blockBash, outsideReadable, outsideWritable, type GuardPolicy } from "../extensions/guard";

const WORKDIR = "/work/repo";
const POLICY: GuardPolicy = { workdir: WORKDIR };

const blocked = (cmd: string): string | null => blockBash(cmd, POLICY);
const withPolicy =
  (patch: Partial<GuardPolicy>) =>
  (cmd: string): string | null =>
    blockBash(cmd, { ...POLICY, ...patch });

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

  test("capabilities.blockedCommands 按命令名拒绝", () => {
    const deny = withPolicy({ blockedCommands: ["frobnicate"] });
    expect(deny("frobnicate --now")).toContain("frobnicate");
    expect(deny("/usr/local/bin/frobnicate")).toContain("frobnicate");
    expect(deny("bun run frobnicate")).toBeNull();
  });

  test("blockedCommands 也认前几个词", () => {
    const deny = withPolicy({ blockedCommands: ["bun publish", "npm publish"] });
    expect(deny("bun publish")).toContain("禁止命令 bun publish");
    expect(deny("bun publish --tag next")).toContain("禁止命令 bun publish");
    expect(deny("/usr/local/bin/bun publish")).toContain("禁止命令 bun publish");
    expect(deny("bun test")).toBeNull();
    expect(deny("bun run publish")).toBeNull();
    expect(deny("npm publish --access public")).toContain("禁止命令 npm publish");
  });
});

describe("blockBash · 目录能力", () => {
  test("默认拒绝读工作副本之外", () => {
    expect(blocked("cat /etc/passwd")).toContain("不可读");
    expect(blocked("ls /")).toContain("不可读");
    expect(blocked("cat ../other/a.ts")).toContain("不可读");
  });

  test("声明 readDirs 后放行，未声明的兄弟目录仍拒绝", () => {
    const read = withPolicy({ readDirs: ["/opt/data"] });
    expect(read("cat /opt/data/report.csv")).toBeNull();
    expect(read("head -n 5 /opt/data/x")).toBeNull();
    expect(read("cat /opt/data2/x")).toContain("不可读");
  });

  test("默认拒绝写工作副本之外", () => {
    expect(blocked("rm -rf /tmp/x")).toContain("不可写");
    expect(blocked("cp a.ts /tmp/a.ts")).toContain("不可写");
  });

  test("声明 writeDirs 后放行写，读也随写放行", () => {
    const write = withPolicy({ writeDirs: ["/tmp/out"] });
    expect(write("rm -rf /tmp/out/x")).toBeNull();
    expect(write("cp a.ts /tmp/out/a.ts")).toBeNull();
    expect(write("cat /tmp/out/a.ts")).toBeNull();
    expect(write("rm -rf /tmp/x")).toContain("不可写");
  });

  test("设备节点与工作副本内路径放行", () => {
    expect(blocked("ls -la > /dev/null")).toBeNull();
    expect(blocked("cat /dev/stdin")).toBeNull();
    expect(blocked("cat src/a.ts")).toBeNull();
    expect(blocked("echo hi > out.txt")).toBeNull();
  });

  test("重定向目标按可写校验", () => {
    expect(blocked("echo hi > /etc/x")).toContain("不可写");
    expect(blocked("bun test 2>/tmp/log")).toContain("不可写");
  });
});

describe("blockBash · 网络能力", () => {
  test("未声明域名时拒绝联网命令，回环地址放行", () => {
    expect(blocked("curl https://example.com/a")).toContain("域名");
    expect(blocked("curl -s http://127.0.0.1:3000/health")).toBeNull();
    expect(blocked("wget http://localhost:8080/x")).toBeNull();
    expect(blocked("ssh git@github.com")).toContain("域名");
    expect(blocked("gh pr view 1")).toContain("域名");
  });

  test("域名按后缀匹配，子域放行、同前缀的别的域拒绝", () => {
    const net = withPolicy({ domains: ["example.com", "github.com"] });
    expect(net("curl https://example.com/a")).toBeNull();
    expect(net("curl -X POST https://api.example.com/v1 -d @payload.json")).toBeNull();
    expect(net("curl https://example.org")).toContain("域名");
    expect(net("curl https://notexample.com")).toContain("域名");
    expect(net("gh pr view 1")).toBeNull();
  });

  test("git 远端操作取仓库配置，联网仍拒绝", () => {
    const net = withPolicy({ domains: ["github.com"] });
    expect(net("git fetch")).toContain("git fetch");
    expect(net("git pull --rebase")).toContain("git pull");
    expect(net("git remote update")).toContain("remote update");
    expect(net("git clone https://github.com/o/r.git")).toBeNull();
    expect(net("git clone https://gitlab.com/o/r.git")).toContain("域名");
    expect(net("git clone ./sub")).toBeNull();
    expect(net("git clone ../other")).toContain("不可读");
    expect(blocked("git clone https://github.com/o/r.git")).toContain("域名");
  });

  test("包管理器的联网子命令映射到注册表域名", () => {
    const npm = withPolicy({ domains: ["registry.npmjs.org"] });
    expect(npm("npm install")).toBeNull();
    expect(npm("bun add zod")).toBeNull();
    expect(npm("npx tsc --noEmit")).toBeNull();
    expect(npm("pip install requests")).toContain("pypi");
    expect(blocked("pip install requests")).toContain("域名");
    expect(blocked("cargo build")).toBeNull();
    const crates = withPolicy({ domains: ["crates.io"] });
    expect(crates("cargo add serde")).toBeNull();
  });
});

describe("blockBash · GUI 能力", () => {
  test("默认关闭时拒绝启动图形应用", () => {
    expect(blocked("open -a Safari")).toContain("GUI");
    expect(blocked("osascript -e 'tell app \"Finder\" to activate'")).toContain("GUI");
    expect(blocked("xdg-open https://example.com")).toContain("GUI");
  });

  test("开启后放行", () => {
    const gui = withPolicy({ gui: true });
    expect(gui("open -a Safari")).toBeNull();
    expect(gui("osascript -e 'tell app \"Finder\" to activate'")).toBeNull();
  });
});

describe("outsideReadable / outsideWritable", () => {
  const policy: GuardPolicy = { workdir: WORKDIR, readDirs: ["/opt/data"], writeDirs: ["/tmp/out"] };

  test("工作副本内放行", () => {
    expect(outsideWritable("/work/repo/a.ts", policy)).toBeNull();
    expect(outsideWritable("src/deep/b.ts", policy)).toBeNull();
    expect(outsideWritable("/work/repo", policy)).toBeNull();
  });

  test("写只认工作副本与 writeDirs，读额外认 readDirs", () => {
    expect(outsideWritable("/work/other/a.ts", policy)).toContain("不可写");
    expect(outsideWritable("../other/a.ts", policy)).not.toBeNull();
    expect(outsideWritable("/work/repo/../other", policy)).not.toBeNull();
    expect(outsideWritable("/etc/passwd", policy)).not.toBeNull();
    expect(outsideWritable("/work/repository/a.ts", policy)).not.toBeNull();
    expect(outsideWritable("/opt/data/x", policy)).toContain("不可写");
    expect(outsideReadable("/opt/data/x", policy)).toBeNull();
    expect(outsideReadable("/tmp/out/x", policy)).toBeNull();
  });

  test("workdir 为空时拒绝并说明原因", () => {
    expect(outsideReadable("a.ts", { workdir: "" })).toContain("工作目录");
  });
});
