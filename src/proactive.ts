import type { Config } from "./config";
import type { IncomingMessage } from "./types";

type Enqueue = (m: IncomingMessage) => Promise<void> | void;

/** 探针一次执行的结果：退出码 + 合并后的输出（已截断） */
export interface ProbeResult {
  code: number;
  out: string;
}

/**
 * 探针的跨进程依赖。
 * 状态与事件占位都落在 store（生产环境是 `meta` / `events` 表），进程重启后仍能认出「这个故障已经开过单」。
 */
export interface ProbeDeps {
  load: (key: string) => string | null;
  save: (key: string, value: string) => void;
  /** 幂等占位：同一 eventId 只成功一次，返回 false 表示已被别人占过 */
  claim: (eventId: string, owner: string, at: number) => boolean;
  now?: () => number;
  run?: (command: string) => ProbeResult;
}

/** 落进 `meta` 的探针状态 */
interface ProbeState {
  signature: string;
  firedAt: number;
}

function sha1(text: string): string {
  return new Bun.CryptoHasher("sha1").update(text).digest("hex");
}

function parseState(raw: string | null): ProbeState | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<ProbeState>;
    if (typeof v.signature !== "string" || typeof v.firedAt !== "number") return null;
    return { signature: v.signature, firedAt: v.firedAt };
  } catch {
    return null;
  }
}

function spawnProbe(command: string): ProbeResult {
  const proc = Bun.spawnSync(["bash", "-lc", command], { stdout: "pipe", stderr: "pipe" });
  const out = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`.trim().slice(-2000);
  return { code: proc.exitCode ?? -1, out };
}

/**
 * 主动发现：
 * 1) 关键词 —— 群里没人 @ 也能接住报障
 * 2) 探针 —— 定时跑一条命令，失败就开单（CI 失败、服务探活都走这个）
 */
export class Proactive {
  private keywordAt = new Map<string, number>();
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private now: () => number;
  private runProbe: (command: string) => ProbeResult;

  constructor(
    private cfg: Config,
    private enqueue: Enqueue,
    private deps: ProbeDeps,
  ) {
    this.now = deps.now ?? Date.now;
    this.runProbe = deps.run ?? spawnProbe;
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
    const run = () => {
      if (this.running) return;
      this.running = true;
      try {
        this.probe();
      } finally {
        this.running = false;
      }
    };
    run();
    this.probeTimer = setInterval(run, every);
  }

  stop(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  /**
   * 同一故障在一次冷却窗口内只开一张单：
   * 状态按探针命令取 jobId 写进 `meta`，eventId 由签名与窗口推导，重启后重复启动天然幂等。
   */
  private probe(): void {
    const p = this.cfg.proactive!.probe!;
    const jobId = sha1(p.command).slice(0, 8);
    const metaKey = `probe:${jobId}`;
    const cooldownMs = (p.cooldownSec ?? 1800) * 1000;
    const at = this.now();
    const { code, out } = this.runProbe(p.command);
    const state = parseState(this.deps.load(metaKey));

    if (code === 0) {
      // 恢复了就清掉签名：同一故障再次出现时按新故障开单
      if (!state || state.signature === "") return;
      this.deps.save(metaKey, JSON.stringify({ signature: "", firedAt: at } satisfies ProbeState));
      return;
    }

    const signature = `${code}:${out}`;
    if (state && state.signature === signature && cooldownMs > 0 && at - state.firedAt < cooldownMs) return;

    const window = Math.floor(at / Math.max(1, cooldownMs));
    const eventId = `proactive:probe:${jobId}:${sha1(signature)}:${window}`;
    // 多进程同时跑、或 meta 丢失时，事件账本兜底：同一窗口只放一张单
    if (!this.deps.claim(eventId, `proactive:${jobId}`, at)) return;
    this.deps.save(metaKey, JSON.stringify({ signature, firedAt: at } satisfies ProbeState));

    void this.enqueue({
      eventId,
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
  }
}
