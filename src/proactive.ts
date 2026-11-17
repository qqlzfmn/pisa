import type { Config } from "./config";
import type { IncomingMessage } from "./types";

type Enqueue = (m: IncomingMessage) => Promise<void> | void;

/**
 * 主动发现：
 * 1) 关键词 —— 群里没人 @ 也能接住报障
 * 2) 探针 —— 定时跑一条命令，失败就开单（CI 失败、服务探活都走这个）
 */
export class Proactive {
  private keywordAt = new Map<string, number>();
  private probeTimer: ReturnType<typeof setInterval> | null = null;
  private lastSignature = "";
  private lastProbeAlertAt = 0;
  private running = false;

  constructor(
    private cfg: Config,
    private enqueue: Enqueue,
  ) {}

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
      // 原消息是否点名 pisa 决定准入落在哪一格，不能替它断言
      mentioned: msg.mentioned ?? false,
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
        const proc = Bun.spawnSync(["bash", "-lc", p.command], { stdout: "pipe", stderr: "pipe" });
        const code = proc.exitCode ?? -1;
        if (code === 0) {
          this.lastSignature = "";
          return;
        }
        const out = `${proc.stdout?.toString() ?? ""}${proc.stderr?.toString() ?? ""}`.trim().slice(-2000);
        const signature = `${code}:${out}`;
        const cooldown = (p.cooldownSec ?? 1800) * 1000;
        if (signature === this.lastSignature && Date.now() - this.lastProbeAlertAt < cooldown) return;
        this.lastSignature = signature;
        this.lastProbeAlertAt = Date.now();
        void this.enqueue({
          eventId: `proactive:probe:${Date.now()}`,
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
    };
    run();
    this.probeTimer = setInterval(run, every);
  }

  stop(): void {
    if (this.probeTimer) clearInterval(this.probeTimer);
    this.probeTimer = null;
  }
}
