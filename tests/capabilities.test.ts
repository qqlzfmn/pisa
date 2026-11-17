import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  capabilityEnv,
  checkBashCommand,
  checkToolCall,
  resolveCapabilities,
  type CapabilitiesConfig,
  type ResolvedCapabilities,
} from "../src/capabilities";
import workerExtension from "../extensions/pisa-worker";
import { Store } from "../src/store";
import type { Task } from "../src/types";

const WORKDIR = "/tmp/pisa-caps-wt";

function policy(over: Partial<CapabilitiesConfig> = {}): ResolvedCapabilities {
  return resolveCapabilities({ default: { readDirs: [], writeDirs: [], secrets: [], domains: [], gui: false }, ...over }, WORKDIR);
}

function allow(caps: ResolvedCapabilities, command: string) {
  const verdict = checkBashCommand(caps, command);
  return verdict.allow;
}

function allowTool(caps: ResolvedCapabilities, tool: string, input: Record<string, unknown> = {}) {
  return checkToolCall(caps, tool, input).allow;
}

describe("resolveCapabilities：默认拒绝", () => {
  test("没有配置时只有工作目录可读写", () => {
    const caps = resolveCapabilities(undefined, WORKDIR);
    expect(caps.readDirs).toEqual([WORKDIR]);
    expect(caps.writeDirs).toEqual([WORKDIR]);
    expect(caps.secrets).toEqual([]);
    expect(caps.domains).toEqual([]);
    expect(caps.gui).toBe(false);
    expect(caps.profile).toBeNull();
    expect(caps.blockedCommands).toContain("git push");
    expect(caps.blockedCommands.some((c) => c.includes("GUI"))).toBe(true);
    expect(caps.blockedCommands.some((c) => c.includes("网络命令"))).toBe(true);
  });

  test("相对目录按工作目录解析，绝对目录保留", () => {
    const caps = resolveCapabilities(
      { default: { readDirs: ["../shared", "/opt/data"], writeDirs: ["../shared"] } },
      WORKDIR,
    );
    expect(caps.readDirs).toEqual([WORKDIR, "/tmp/shared", "/opt/data"]);
    expect(caps.writeDirs).toEqual([WORKDIR, "/tmp/shared"]);
  });

  test("档案按顺序叠加，后面的层覆盖前面的层", () => {
    const cfg: CapabilitiesConfig = {
      default: { readDirs: ["docs"], domains: ["Example.COM"] },
      profiles: { gui: { gui: true, domains: ["api.github.com"] } },
    };
    const caps = resolveCapabilities(cfg, WORKDIR, { readDirs: ["repo"] }, { profile: "gui", readDirs: ["task"] });
    expect(caps.readDirs).toEqual([WORKDIR, "/tmp/pisa-caps-wt/task"]);
    expect(caps.domains).toEqual(["api.github.com"]);
    expect(caps.gui).toBe(true);
    expect(caps.profile).toBe("gui");
  });

  test("引用未知档案直接报错", () => {
    expect(() => resolveCapabilities({}, WORKDIR, { profile: "nope" })).toThrow(/未知的能力档案/);
  });

  test("域名去重并转小写", () => {
    const caps = resolveCapabilities({ default: { domains: ["API.GitHub.com", "api.github.com "] } }, WORKDIR);
    expect(caps.domains).toEqual(["api.github.com"]);
  });
});

describe("checkBashCommand：默认拒绝", () => {
  const caps = policy();

  test("仓库外的路径一律拒绝", () => {
    expect(allow(caps, "cat /etc/passwd")).toBe(false);
    expect(allow(caps, "cat ~/.ssh/id_rsa")).toBe(false);
    expect(allow(caps, "cd .. && cat ../other/file")).toBe(false);
    expect(allow(caps, "ls -la")).toBe(true);
  });

  test("能读系统命令但不读仓库外的数据", () => {
    expect(checkBashCommand(caps, "/bin/cat notes.md").allow).toBe(true);
    expect(checkBashCommand(caps, "/etc/passwd").allow).toBe(false);
  });

  test("写入越界被拒绝", () => {
    expect(checkBashCommand(caps, "echo hi > out.txt").allow).toBe(true);
    expect(checkBashCommand(caps, "echo hi > /etc/passwd").allow).toBe(false);
    expect(checkBashCommand(caps, "mkdir -p build/tmp").allow).toBe(true);
    expect(checkBashCommand(caps, "mkdir -p /tmp/elsewhere").allow).toBe(false);
    expect(checkBashCommand(caps, "rm -rf /").allow).toBe(false);
  });

  test("没有域名时网络命令一律拒绝", () => {
    expect(checkBashCommand(caps, "curl https://example.com").allow).toBe(false);
    expect(checkBashCommand(caps, "ssh deploy@prod.example.com").allow).toBe(false);
    expect(checkBashCommand(caps, "git fetch origin").allow).toBe(false);
  });

  test("破坏性命令即使目录内也拒绝", () => {
    expect(checkBashCommand(caps, "git push origin main").allow).toBe(false);
    expect(checkBashCommand(caps, "sudo ls").allow).toBe(false);
    expect(checkBashCommand(caps, "git status").allow).toBe(true);
  });

  test("没有 GUI 时拒绝 GUI 命令", () => {
    expect(checkBashCommand(caps, "open -a Safari https://example.com").allow).toBe(false);
    expect(checkBashCommand(caps, "osascript -e 'tell app \"Finder\" to activate'").allow).toBe(false);
  });

  test("引号与变量展开不能绕过路径与写入检查", () => {
    expect(checkBashCommand(caps, `cat "/etc/passwd"`).allow).toBe(false);
    expect(checkBashCommand(caps, "cat '/etc/passwd'").allow).toBe(false);
    expect(checkBashCommand(caps, "cat $HOME/.ssh/id_rsa").allow).toBe(false);
    expect(checkBashCommand(caps, "cat ${HOME}/.ssh/id_rsa").allow).toBe(false);
    expect(checkBashCommand(caps, `echo x > "/etc/passwd"`).allow).toBe(false);
    expect(checkBashCommand(caps, "echo x > $HOME/.zshrc").allow).toBe(false);
    // 正则里的 $ 锚点不是变量展开
    expect(checkBashCommand(caps, "grep -E '^/api/$' src/a.ts").allow).toBe(true);
  });
});

describe("checkToolCall：默认拒绝", () => {
  const caps = policy();

  test("文件工具受可读/可写目录约束", () => {
    expect(allowTool(caps, "read", { path: "src/a.ts" })).toBe(true);
    expect(allowTool(caps, "read", { path: "/etc/passwd" })).toBe(false);
    expect(allowTool(caps, "edit", { file_path: "../outside.ts" })).toBe(false);
    expect(allowTool(caps, "glob", { path: "src/**/*.ts" })).toBe(true);
    expect(allowTool(caps, "grep", { path: "src;!**/*.test.ts" })).toBe(true);
  });

  test("GUI 工具没有开关时拒绝", () => {
    expect(allowTool(caps, "computer", { action: "click" })).toBe(false);
    expect(allowTool(caps, "browser", { action: "open" })).toBe(false);
    expect(allowTool(caps, "todo", {})).toBe(true);
  });
});

describe("显式放行", () => {
  const cfg: CapabilitiesConfig = {
    default: { secrets: [], domains: [], gui: false },
    profiles: { gui: { gui: true } },
  };
  const caps = resolveCapabilities(cfg, WORKDIR, {
    profile: "gui",
    readDirs: ["../shared"],
    writeDirs: ["../shared", "dist"],
    secrets: ["GH_TOKEN"],
    domains: ["github.com"],
  });

  test("域名白名单只放行指定主机与子域", () => {
    expect(checkBashCommand(caps, "curl https://github.com/x").allow).toBe(true);
    expect(checkBashCommand(caps, "curl https://api.github.com/x").allow).toBe(true);
    expect(checkBashCommand(caps, "curl https://evil.com/x").allow).toBe(false);
    expect(checkBashCommand(caps, "curl https://github.com.evil.com/x").allow).toBe(false);
    expect(checkBashCommand(caps, "curl https://evil.com#@github.com/x").allow).toBe(false);
    expect(checkBashCommand(caps, "ssh deploy@github.com").allow).toBe(true);
    expect(checkBashCommand(caps, "ssh deploy@evil.com").allow).toBe(false);
    expect(checkBashCommand(caps, "git clone https://github.com/o/r").allow).toBe(true);
    expect(checkBashCommand(caps, "git fetch origin").allow).toBe(true);
  });

  test("显式目录与 GUI 放行", () => {
    expect(allowTool(caps, "read", { path: "../shared/a.txt" })).toBe(true);
    expect(allowTool(caps, "edit", { path: "../shared/a.txt" })).toBe(true);
    expect(allowTool(caps, "edit", { path: "../elsewhere/a.txt" })).toBe(false);
    expect(allowTool(caps, "computer", { action: "click" })).toBe(true);
    expect(checkBashCommand(caps, "open -a Safari https://github.com").allow).toBe(true);
    expect(caps.blockedCommands.some((c) => c.includes("GUI"))).toBe(false);
  });

  test("密钥按名字透传", () => {
    const env = capabilityEnv(caps, {
      PATH: "/usr/bin",
      HOME: "/Users/u",
      GH_TOKEN: "ghp_x",
      PISA_TELEGRAM_TOKEN: "telegram",
      OMP_HOME: "/omp",
      OMP_API_KEY: "leak",
    });
    expect(env.PATH).toBe("/usr/bin");
    expect(env.GH_TOKEN).toBe("ghp_x");
    expect(env.OMP_HOME).toBe("/omp");
    expect(env.PISA_TELEGRAM_TOKEN).toBeUndefined();
    expect(env.OMP_API_KEY).toBeUndefined();
    expect(JSON.parse(env.PISA_CAPABILITIES!)).toEqual(caps);
  });

  test("声明的密钥缺失时报错而不是静默放行", () => {
    const missing = resolveCapabilities({}, WORKDIR, { secrets: ["NOPE"] });
    expect(() => capabilityEnv(missing, { PATH: "/usr/bin" })).toThrow(/缺少密钥环境变量：NOPE/);
  });
});

describe("任务记录", () => {
  test("能力快照与越界审计写入任务记录", () => {
    const store = new Store(":memory:");
    const caps = resolveCapabilities({ default: { domains: ["github.com"] } }, WORKDIR);
    const task: Task = {
      id: "t_audit",
      source: "test",
      channel: "cli",
      chatId: "c1",
      requester: "u1",
      repo: "demo",
      prompt: "x",
      status: "running",
      branch: null,
      prUrl: null,
      sessionId: null,
      baseRef: null,
      context: null,
      replyPr: null,
      replyIssue: null,
      replyRepo: null,
      capabilities: caps,
      summary: null,
      error: null,
      createdAt: 1,
      startedAt: null,
      endedAt: null,
      cancelRequested: false,
    };
    store.insertTask(task);
    expect(store.get("t_audit")?.capabilities).toEqual(caps);

    store.recordAudit("t_audit", "blocked", JSON.stringify({ tool: "bash", detail: "curl https://evil.com" }));
    store.recordAudit("t_audit", "blocked", JSON.stringify({ tool: "read", detail: "/etc/passwd" }));
    const audit = store.auditOf("t_audit");
    expect(audit.map((a) => a.kind)).toEqual(["blocked", "blocked"]);
    expect(audit[0]!.detail).toContain("curl https://evil.com");
    expect(audit[1]!.detail).toContain("/etc/passwd");
    store.close();
  });
});

describe("Worker 扩展按能力策略拦截", () => {
  let dir: string;
  let progressFile: string;
  let handlers: Map<string, (event: unknown, ctx?: unknown) => unknown>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "pisa-caps-ext-"));
    mkdirSync(join(dir, "work"), { recursive: true });
    progressFile = join(dir, "progress.jsonl");
    process.env.PISA_PROGRESS_FILE = progressFile;
    process.env.PISA_WORKDIR = join(dir, "work");
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.PISA_CAPABILITIES;
  });

  function install(caps: ResolvedCapabilities): Map<string, (event: unknown, ctx?: unknown) => unknown> {
    process.env.PISA_CAPABILITIES = JSON.stringify(caps);
    const map = new Map<string, (event: unknown, ctx?: unknown) => unknown>();
    // 扩展的签名由 omp 提供；测试只替换其中的 on 注册表
    const api = {
      on(event: string, handler: (e: unknown, c?: unknown) => unknown) {
        map.set(event, handler);
      },
    } as unknown as Parameters<typeof workerExtension>[0];
    void workerExtension(api);
    return map;
  }

  test("默认策略下拦下网络命令并写入进度文件", () => {
    handlers = install(resolveCapabilities(undefined, join(dir, "work")));
    const verdict = handlers.get("tool_call")!({ toolName: "bash", input: { command: "curl https://evil.com" } }) as {
      block: boolean;
      reason: string;
    };
    expect(verdict.block).toBe(true);
    expect(verdict.reason).toContain("未授权网络访问");

    const lines = readFileSync(progressFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    const blocked = lines.find((l) => l.type === "blocked")!;
    expect(blocked.tool).toBe("bash");
    expect(String(blocked.detail)).toContain("curl https://evil.com");
    expect(String(blocked.reason)).toContain("未授权网络访问");
  });

  test("放行的命令不拦截，仍然上报进度", () => {
    writeFileSync(progressFile, "");
    const verdict = handlers.get("tool_call")!({ toolName: "bash", input: { command: "ls -la" } });
    expect(verdict).toBeUndefined();
    const lines = readFileSync(progressFile, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines.some((l) => l.type === "tool" && l.detail === "ls -la")).toBe(true);
  });

  test("放行 GUI 与域名后不再拦截", () => {
    handlers = install(
      resolveCapabilities({}, join(dir, "work"), { gui: true, domains: ["github.com"] }),
    );
    expect(handlers.get("tool_call")!({ toolName: "computer", input: { action: "click" } })).toBeUndefined();
    expect(handlers.get("tool_call")!({ toolName: "bash", input: { command: "curl https://github.com" } })).toBeUndefined();
  });
});
