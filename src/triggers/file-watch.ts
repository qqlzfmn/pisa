import { existsSync, watch, type FSWatcher } from "node:fs";
import { join, resolve } from "node:path";
import type { FileWatchPathConfig, FileWatchTriggerConfig } from "../config";
import type { IncomingMessage } from "../types";
import {
  commandText,
  dispatch,
  TriggerError,
  type TriggerAdapter,
  type TriggerOutcome,
} from "./types";

export interface FileWatchEvent {
  /** 变化文件的绝对路径 */
  path: string;
  /** 被监听的目录或文件 */
  root: string;
  event: "rename" | "change";
  /** 去重键的时间分量：同一路径的多次事件靠它区分 */
  at: number;
}

export interface FileWatchOptions {
  config: FileWatchTriggerConfig;
  trigger: string;
  chatId: string;
  userId: string;
  repo?: string;
  now?: () => number;
}

/**
 * 文件监听适配层：`fs.watch` 的 `rename`/`change` 事件去抖后归一成任务消息。
 *
 * 不走 HTTP：`start` 内部把事件交给 `dispatch`，与三个网络入口共用同一套归一化与
 * 去重。目录监听只上报文件名，路径补上目录前缀；不对已发生的变化补发，停机期间
 * 的改动不会积压。
 */
export class FileWatchAdapter implements TriggerAdapter<FileWatchEvent, FileWatchEvent> {
  readonly name = "file-watch";
  private readonly watchers: FSWatcher[] = [];
  private readonly timers = new Map<string, Timer>();
  private readonly now: () => number;

  constructor(private readonly opts: FileWatchOptions) {
    this.now = opts.now ?? Date.now;
  }

  /** 只认监听清单内的根路径；删除事件的文件已不存在，所以不校验变化文件本身 */
  async verify(raw: FileWatchEvent): Promise<FileWatchEvent> {
    if (!this.item(raw.root)) throw new TriggerError(400, `路径不在监听清单：${raw.root}`);
    return raw;
  }

  normalize(raw: FileWatchEvent): TriggerOutcome {
    const item = this.item(raw.root);
    if (!item) throw new TriggerError(400, `路径不在监听清单：${raw.root}`);
    const dedupeKey = this.dedupeKey(raw);
    const prompt = item.prompt.replace(/\{path\}/g, raw.path);
    return {
      event: {
        dedupeKey,
        message: {
          eventId: dedupeKey,
          channel: "file-watch",
          chatId: this.opts.chatId,
          userId: this.opts.userId,
          actor: "file-watch",
          repo: item.repo ?? this.opts.repo,
          isDirect: true,
          text: commandText(this.opts.trigger, prompt),
          threadKey: `file-watch:${raw.root}`,
          messageKey: dedupeKey,
          version: "",
          receivedAt: this.now(),
        },
      },
    };
  }

  dedupeKey(raw: FileWatchEvent): string {
    return `file-watch:${raw.path}:${raw.at}`;
  }

  /** 监听全部配置项；同一路径的连续事件在去抖窗口内合并成一条 */
  start(handle: (message: IncomingMessage) => Promise<void>): void {
    // 先校验全部路径再建监听：任一缺失都不留下半套 watcher
    const roots = this.opts.config.paths.map((item) => {
      if (!existsSync(item.path)) throw new Error(`文件监听路径不存在：${item.path}`);
      return resolve(item.path);
    });
    for (const root of roots) {
      const watcher = watch(root, { recursive: false }, (event, filename) => {
        const name = typeof filename === "string" && filename ? filename : "";
        const path = name ? join(root, name) : root;
        const key = `${root}\0${name}`;
        clearTimeout(this.timers.get(key));
        this.timers.set(
          key,
          setTimeout(() => {
            this.timers.delete(key);
            void dispatch(this, { path, root, event, at: this.now() }, handle).catch((err: unknown) => {
              console.error(`[pisa] 文件监听事件被拒：${path}`, err instanceof Error ? err.message : err);
            });
          }, this.opts.config.debounceMs ?? 500),
        );
      });
      watcher.on("error", () => {
        // 监听失败不拖垮主进程：入口已声明，运维从日志定位
        console.error(`[pisa] 文件监听异常：${root}`);
      });
      this.watchers.push(watcher);
    }
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const watcher of this.watchers.splice(0)) watcher.close();
  }

  private item(root: string): FileWatchPathConfig | undefined {
    return this.opts.config.paths.find((item) => resolve(item.path) === root);
  }
}
