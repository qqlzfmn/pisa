import { createHash } from "node:crypto";
import type { Config } from "./config";
import type { IncomingMessage } from "./types";

type Enqueue = (m: IncomingMessage) => Promise<void> | void;

/** meta 读写；Store 天然满足该形状 */
export interface MetaStore {
  getMeta(key: string): string | null;
  setMeta(key: string, value: string): void;
}

/** 探针跨重启状态：最近一次故障的签名与触发时间 */
export interface ProbeState {
  signature: string;
  firedAt: number;
}

export interface ProactiveDeps {
  /** 缺省时退化为进程内记忆，重启即丢 */
  meta?: MetaStore;
  now?: () => number;
  /** 替换真实探针执行；测试注入固定退出码与输出 */
  runProbe?: (command: string) => { code: number; out: string };
}

type ProbeConfig = NonNullable<NonNullable<Config["proactive"]>["probe"]>;

/** 探针身份取命令哈希前 12 位：同一份配置重启后仍是同一个 jobId，且够短能进 meta key */
const probeJobId = (command: string): string => createHash("sha1").update(command).digest("hex").slice(0, 12);

const memoryMeta = (): MetaStore => {
  const m = new Map<string, string>();
  return { getMeta: (k) => m.get(k) ?? null, setMeta: (k, v) => void m.set(k, v) };
};

const runBashProbe = (command: string): { code: number; out: string } => {
  const proc = Bun.spawnSync(["bash", "-lc", command], { stdout: "pipe", stderr: "pipe" });
  const out = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`.trim().slice(-2000);
  return { code: proc.exitCode ?? -1, out };
};

/**
 * 主动发现：
 * 1) 关键词 —— 群里没人 @ 也能接住报障
 * 2) 探针 —— 定时跑一条命令，失败就开单（CI 失败、服务探活都走这个）
 */
export class Proactive {
  private keywordAt = new Map<string, number>();
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private meta: MetaStore;
  private now: () => number;
  private runProbe: (command: string) => { code: number; out: string };

  constructor(
    private cfg: Config,
    private enqueue: Enqueue,
    deps: ProactiveDeps = {},
  ) {
    this.meta = deps.meta ?? memoryMeta();
    this.now = deps.now ?? Date.now;
    this.runProbe = deps.runProbe ?? runBashProbe;
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
    const now = this.now();
    const last = this.keywordAt.get(msg.chatId) ?? 0;
    if (now - last < cooldown) return;
    this.keywordAt.set(msg.chatId, now);

    void this.enqueue({
      eventId: `proactive:kw:${msg.channel}:${msg.chatId}:${msg.receivedAt ?? now}`,
      channel: msg.channel,
      chatId: k.chatId ?? msg.chatId,
      userId: k.userId ?? this.cfg.whitelist.users[0] ?? msg.userId,
      isDirect: true,
      text: [
        k.prompt ?? "群里有人报障且没有人接：先定位原因，能修就修，不能修给出可执行的下一步。",
        "",
        `原消息（来自 ${msg.userId}）：${text}`,
      ].join("\n"),
    });
  }

  start(): void {
    const p = this.cfg.proactive?.probe;
    if (!p?.enabled || !p.command) return;
    const every = Math.max(5, p.intervalSec ?? 60) * 1000;
    const run = () => this.checkProbe(p);
    run();
    this.probeTimer = setInterval(run, every);
  }

  stop(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  /**
   * 一次探针：签名与冷却落 meta，重启后同一故障在同一窗口内不再开单；
   * eventId 由签名与冷却窗口推导，同一窗口的重复运行由 claimEvent 兜住。
   */
  private checkProbe(p: ProbeConfig): void {
    if (this.running) return;
    this.running = true;
    try {
      const jobId = probeJobId(p.command);
      const key = `probe:${jobId}`;
      // 0 表示不限流；窗口序号不能除以 0
      const cooldown = Math.max(1, (p.cooldownSec ?? 1800) * 1000);
      const { code, out } = this.runProbe(p.command);
      const prev = this.readState(key);

      if (code === 0) {
        if (prev?.signature) this.meta.setMeta(key, JSON.stringify({ signature: "", firedAt: 0 }));
        return;
      }

      const signature = `${code}:${out}`;
      const now = this.now();
      if (prev && prev.signature === signature && now - prev.firedAt < cooldown) return;
      this.meta.setMeta(key, JSON.stringify({ signature, firedAt: now }));

      void this.enqueue({
        eventId: `proactive:probe:${jobId}:${createHash("sha1").update(signature).digest("hex")}:${Math.floor(now / cooldown)}`,
        channel: "proactive",
        chatId: p.chatId,
        userId: p.userId,
        repo: p.repo,
        isDirect: true,
        text: [
          p.prompt ?? "自动探针失败，请定位原因并修复。",
          "",
          `探针：${p.command}`,
          `退出码：${code}`,
          out ? `输出：\n${out}` : "（无输出）",
        ].join("\n"),
      });
    } finally {
      this.running = false;
    }
  }

  private readState(key: string): ProbeState | null {
    const raw = this.meta.getMeta(key);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as Partial<ProbeState>;
      if (typeof v.signature === "string" && typeof v.firedAt === "number") return { signature: v.signature, firedAt: v.firedAt };
    } catch {
      // 落到下面的告警
    }
    console.warn(`[pisa] 探针状态损坏，按无记录处理：${key}`);
    return null;
  }
}
