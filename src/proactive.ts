import { createHash } from "node:crypto";
import type { Config } from "./config";
import type { Store } from "./store";
import type { IncomingMessage } from "./types";
import { defaultPrompts, type PromptLibrary } from "./prompts";

type Enqueue = (m: IncomingMessage) => Promise<void> | void;

/** 探针状态只需键值读写：生产传 Store，测试传内存实现 */
export type ProbeState = Pick<Store, "getMeta" | "setMeta">;

/** 探针执行结果：退出码 + 原始输出 */
export interface ProbeResult {
  code: number;
  output: string;
}

export interface ProactiveDeps {
  store: ProbeState;
  now?: () => number;
  runProbe?: (command: string) => ProbeResult;
  /** 默认提示词来源；缺省只用内置段落 */
  prompts?: PromptLibrary;
}

type ProbeConfig = NonNullable<NonNullable<Config["proactive"]>["probe"]>;

/** 冷却窗口内的失败身份，存在 meta 的 probe:<jobId> 下 */
interface ProbeFailure {
  signature: string;
  firedAt: number;
}

const NO_FAILURE: ProbeFailure = { signature: "", firedAt: 0 };

const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

/** 首选真实执行的探针；测试用 deps.runProbe 替换 */
function spawnProbe(command: string): ProbeResult {
  const proc = Bun.spawnSync(["bash", "-lc", command], { stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode ?? -1, output: `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}` };
}

/**
 * 主动发现：
 * 1) 关键词 —— 群里没人 @ 也能接住报障
 * 2) 探针 —— 定时跑一条命令，失败就开单（CI 失败、服务探活都走这个）
 */
export class Proactive {
  private keywordAt = new Map<string, number>();
  private probeTimer: ReturnType<typeof setInterval> | undefined;
  private running = false;
  private readonly now: () => number;
  private readonly runProbe: (command: string) => ProbeResult;
  private readonly prompts: PromptLibrary;

  constructor(
    private cfg: Config,
    private enqueue: Enqueue,
    private deps: ProactiveDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.runProbe = deps.runProbe ?? spawnProbe;
    this.prompts = deps.prompts ?? defaultPrompts();
  }

  /** 每条入站消息都过一遍；只有群聊且没带触发词时才可能触发 */
  observe(msg: IncomingMessage): void {
    const k = this.cfg.proactive?.keywords;
    if (!k?.enabled || !k.words.length) return;
    if (msg.isDirect) return;
    const text = msg.text.trim();
    if (!text || text.startsWith(this.cfg.trigger) || text.startsWith("/")) return;
    if (k.chatId && msg.chatId !== k.chatId) return;
    if (!k.words.some((w) => text.includes(w))) return;

    const cooldown = (k.cooldownSec ?? 600) * 1000;
    const last = this.keywordAt.get(msg.chatId) ?? 0;
    if (Date.now() - last < cooldown) return;
    this.keywordAt.set(msg.chatId, Date.now());

    void this.enqueue({
      eventId: `proactive:kw:${msg.channel}:${msg.chatId}:${msg.receivedAt ?? Date.now()}`,
      channel: msg.channel,
      chatId: k.chatId ?? msg.chatId,
      userId: k.userId ?? this.cfg.whitelist.users[0] ?? msg.userId,
      isDirect: true,
      text: [
        k.prompt ?? this.prompts.render("proactive.keywords"),
        "",
        `原消息（来自 ${msg.userId}）：${text}`,
      ].join("\n"),
    });
  }

  start(): void {
    const p = this.cfg.proactive?.probe;
    if (!p?.enabled || !p.command) return;
    const every = Math.max(5, p.intervalSec ?? 60) * 1000;
    const jobId = sha1(p.command).slice(0, 12);
    const cooldownMs = Math.max(1, p.cooldownSec ?? 1800) * 1000;
    const run = () => {
      if (this.running) return;
      this.running = true;
      try {
        this.tickProbe(p, jobId, cooldownMs);
      } finally {
        this.running = false;
      }
    };
    run();
    this.probeTimer = setInterval(run, every);
  }

  /**
   * 探针失败身份与触发时间落 meta（key=probe:<jobId>），重启后同一故障仍在冷却内就不开单；
   * eventId 按签名与冷却窗口推导，同一窗口里重复投递会被事件账本与触发器一并吞掉。
   */
  private tickProbe(p: ProbeConfig, jobId: string, cooldownMs: number): void {
    const { code, output } = this.runProbe(p.command);
    const out = output.trim().slice(-2000);
    const key = `probe:${jobId}`;

    if (code === 0) {
      if (this.loadFailure(key).signature) this.storeFailure(key, NO_FAILURE);
      return;
    }

    const signature = `${code}:${out}`;
    const now = this.now();
    const prev = this.loadFailure(key);
    if (prev.signature === signature && now - prev.firedAt < cooldownMs) return;

    this.storeFailure(key, { signature, firedAt: now });
    void this.enqueue({
      eventId: `proactive:probe:${jobId}:${sha1(signature)}:${Math.floor(now / cooldownMs)}`,
      channel: "proactive",
      chatId: p.chatId,
      userId: p.userId,
      repo: p.repo,
      isDirect: true,
      text: [
        p.prompt ?? this.prompts.render("proactive.probe", {}, p.repo),
        "",
        `探针：${p.command}`,
        `退出码：${code}`,
        out ? `输出：\n${out}` : "（无输出）",
      ].join("\n"),
    });
  }

  private loadFailure(key: string): ProbeFailure {
    const raw = this.deps.store.getMeta(key);
    if (!raw) return NO_FAILURE;
    try {
      const value = JSON.parse(raw) as Partial<ProbeFailure> | null;
      if (typeof value?.signature !== "string" || typeof value.firedAt !== "number" || !Number.isFinite(value.firedAt)) {
        return NO_FAILURE;
      }
      return { signature: value.signature, firedAt: value.firedAt };
    } catch {
      return NO_FAILURE;
    }
  }

  private storeFailure(key: string, failure: ProbeFailure): void {
    this.deps.store.setMeta(key, JSON.stringify(failure));
  }

  stop(): void {
    clearInterval(this.probeTimer);
    this.probeTimer = undefined;
  }
}
