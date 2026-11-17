import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, statSync, watch, type FSWatcher } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { FileTriggerConfig } from "../config";
import type { IncomingMessage } from "../types";
import type { TriggerSource } from "./types";

/** 内容摘要只取文件头部，足够区分「同一份内容」又不读整个大文件 */
const SAMPLE_BYTES = 1 << 20;
const DEFAULT_DEBOUNCE_MS = 500;
const DEFAULT_PROMPT = "检查这次文件变化是否符合预期。";

export interface FileTriggerDeps {
  trigger: string;
  deliver: (m: IncomingMessage) => void | Promise<unknown>;
}

/**
 * 本地文件监听：目录递归、单文件监听父目录，变化在去抖窗口内合并成一条消息。
 * 去重键由「路径 + 大小 + 内容摘要」算出：同一份内容重新写入键不变，Router 只建一个任务。
 */
export class FileTrigger implements TriggerSource {
  private readonly watchers: FSWatcher[] = [];
  private readonly pending = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly cfg: FileTriggerConfig,
    private readonly deps: FileTriggerDeps,
  ) {}

  start(): void {
    for (const target of this.cfg.paths) {
      const abs = resolve(target);
      let isDirectory: boolean;
      try {
        isDirectory = statSync(abs).isDirectory();
      } catch {
        console.error(`[pisa] 监听路径不存在，已跳过：${abs}`);
        continue;
      }
      try {
        const watcher = isDirectory
          ? watch(abs, { recursive: true }, (_event, file) => this.queue(abs, file))
          : watch(dirname(abs), (_event, file) => {
              if (file === basename(abs)) this.queue(dirname(abs), file);
            });
        this.watchers.push(watcher);
      } catch (err) {
        console.error(`[pisa] 监听失败已跳过 · ${abs}：${(err as Error).message}`);
      }
    }
  }

  stop(): void {
    for (const watcher of this.watchers) watcher.close();
    this.watchers.length = 0;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }

  private queue(root: string, file: string | null): void {
    if (!file) return;
    const abs = resolve(root, file);
    try {
      if (!statSync(abs).isFile()) return;
    } catch {
      return; // 删除事件：没有内容可摘要
    }
    this.pending.add(abs);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.cfg.debounceMs ?? DEFAULT_DEBOUNCE_MS);
  }

  private async flush(): Promise<void> {
    this.timer = undefined;
    const paths = [...this.pending].sort();
    this.pending.clear();
    if (paths.length === 0) return;
    const message: IncomingMessage = {
      eventId: this.dedupeKey(paths),
      channel: "files",
      chatId: this.cfg.chatId,
      userId: this.cfg.userId,
      text: `${this.deps.trigger} ${this.body(paths)}`,
      repo: this.cfg.repo,
      isDirect: true,
    };
    try {
      await this.deps.deliver(message);
    } catch (err) {
      console.warn(`[pisa] 文件变化投递失败：${(err as Error).message}`);
    }
  }

  private body(paths: string[]): string {
    return [
      `文件变化 · ${paths.length} 个文件`,
      ...paths.map((p) => `- ${p}`),
      "",
      this.cfg.prompt ?? DEFAULT_PROMPT,
    ].join("\n");
  }

  private dedupeKey(paths: string[]): string {
    const hash = createHash("sha256");
    for (const path of paths) hash.update(path).update("\0").update(this.digest(path));
    return `files:${hash.digest("hex").slice(0, 32)}`;
  }

  /** 文件大小 + 头部内容的摘要；读不到时退化为空摘要，不阻断遍历 */
  private digest(path: string): string {
    try {
      const size = statSync(path).size;
      const buffer = Buffer.alloc(Math.min(size, SAMPLE_BYTES));
      const fd = openSync(path, "r");
      try {
        const read = readSync(fd, buffer, 0, buffer.length, 0);
        return `${size}:${createHash("sha256").update(buffer.subarray(0, read)).digest("hex")}`;
      } finally {
        closeSync(fd);
      }
    } catch {
      return "-";
    }
  }
}
