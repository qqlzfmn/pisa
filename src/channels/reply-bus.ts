import type { ChannelAdapter, DeliveryReceipt } from "../types";

/** 每个本机会话缓冲的回复条数上限；常驻进程不能无限增长 */
const BUFFER_LINES = 200;

/**
 * Router 的回执总线：本机会话（控制台、管理接口）的 chatId 由它收集，
 * 其余 chatId 原样转发给真实通道。任务完成后的推送也走这里，
 * 所以本机会话的缓冲区有上限，转发路径不落内存。
 */
export class ReplyBus implements ChannelAdapter {
  readonly name = "local";
  private readonly inbox = new Map<string, string[]>();

  /**
   * @param chatId 主本机会话（控制台）
   * @param down 真实通道；缺省时非本机会话的回复被丢弃
   * @param local 其它本机会话 chatId（管理接口投递的任务）
   */
  constructor(
    private readonly chatId: string,
    private readonly down?: ChannelAdapter,
    private readonly local: readonly string[] = [],
  ) {}

  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  async send(chatId: string, text: string): Promise<DeliveryReceipt | void> {
    if (chatId !== this.chatId && !this.local.includes(chatId)) {
      await this.down?.send(chatId, text);
      return;
    }
    const list = this.inbox.get(chatId) ?? [];
    list.push(text);
    this.inbox.set(chatId, list.slice(-BUFFER_LINES));
  }

  /** 取出并清空该会话已累积的回执 */
  take(chatId = this.chatId): string[] {
    const list = this.inbox.get(chatId) ?? [];
    this.inbox.delete(chatId);
    return list;
  }
}
