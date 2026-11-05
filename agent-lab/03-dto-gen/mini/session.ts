/**
 * 会话状态与中断恢复。
 *
 * 为什么需要它：agent 循环跑到第 8 轮挂了（网络断、预算超、进程被杀），
 * 前 7 轮的工具调用结果就全丢了。重跑要重新读一遍所有文件，
 * 既慢又花钱。真实场景里长任务必然会中断，这不是边缘情况。
 *
 * 实现上的关键决定：快照存【完整的 messages 数组】而不是「我的业务状态」。
 *
 * 一开始我想存「读过哪些文件、提交过几次」这种语义化状态，恢复时重建 messages。
 * 但那样要为每种 agent 写一份重建逻辑，而且极易漏 —— 漏了什么只有跑到那一步才知道。
 * 存 messages 原文是无脑的，但它就是模型看到的全部，不可能漏。
 *
 * 代价是快照文件大（一次 DTO 任务约 50KB）。值得。
 */
import fs from "node:fs/promises";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";

/** 快照格式。带版本号是为了以后改结构时能识别旧文件 */
export interface Snapshot {
  version: 1;
  id: string;
  createdAt: string;
  updatedAt: string;
  turns: number;
  messages: Anthropic.MessageParam[];
  /** 调用方自己的状态，比如「提交过几次」。框架不解释它 */
  meta: Record<string, unknown>;
}

export class Session {
  readonly id: string;
  messages: Anthropic.MessageParam[] = [];
  turns = 0;
  meta: Record<string, unknown> = {};
  private readonly createdAt: string;

  constructor(id?: string) {
    this.id = id ?? `s${Date.now().toString(36)}`;
    this.createdAt = new Date().toISOString();
  }

  push(msg: Anthropic.MessageParam): void {
    this.messages.push(msg);
  }

  /** 最后一条消息是不是 assistant 的 —— 恢复时用来判断该从哪继续 */
  get lastRole(): "user" | "assistant" | undefined {
    return this.messages[this.messages.length - 1]?.role;
  }

  toSnapshot(): Snapshot {
    return {
      version: 1,
      id: this.id,
      createdAt: this.createdAt,
      updatedAt: new Date().toISOString(),
      turns: this.turns,
      messages: this.messages,
      meta: this.meta,
    };
  }

  static fromSnapshot(snap: Snapshot): Session {
    if (snap.version !== 1) {
      throw new Error(`快照版本 ${snap.version} 不支持，当前只认 version 1`);
    }
    const s = new Session(snap.id);
    s.messages = snap.messages;
    s.turns = snap.turns;
    s.meta = snap.meta;
    return s;
  }

  async save(dir: string): Promise<string> {
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, `${this.id}.json`);
    // 先写临时文件再 rename —— 进程正好在写快照时被杀，
    // 不会留下一个半截的 JSON 把下次恢复也搞坏
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(this.toSnapshot(), null, 2), "utf8");
    await fs.rename(tmp, file);
    return file;
  }

  static async load(file: string): Promise<Session> {
    const raw = await fs.readFile(file, "utf8");
    return Session.fromSnapshot(JSON.parse(raw) as Snapshot);
  }

  /**
   * 恢复后修剪消息尾部，保证能继续调用 API。
   *
   * 这是恢复功能真正的难点，不是存取。Anthropic 的硬约束是
   * 「每个 tool_use 后面必须紧跟对应的 tool_result」，而中断很可能
   * 正好发生在模型返回了 tool_use、工具还没执行完的时刻 ——
   * 这时候直接拿快照继续调用就是 400。
   *
   * 处理方式是把末尾那条「有 tool_use 但没配 tool_result」的 assistant
   * 消息整条丢掉，让模型重新决策一次。丢一轮比整个会话报废划算。
   *
   * 这个坑在 patterns.ts 的 Reflexion 里已经踩过一次，当时是自省分支
   * 漏了 tool_result。同一个约束，两个完全不同的触发路径。
   */
  repair(): { dropped: number; reason?: string } {
    let dropped = 0;

    while (this.messages.length > 0) {
      const last = this.messages[this.messages.length - 1]!;
      if (last.role !== "assistant") break;

      const content = last.content;
      const hasToolUse =
        Array.isArray(content) && content.some((b) => b.type === "tool_use");
      if (!hasToolUse) break;

      this.messages.pop();
      dropped++;
    }

    return dropped > 0
      ? { dropped, reason: "末尾有未配 tool_result 的 tool_use，丢弃后重新决策" }
      : { dropped: 0 };
  }
}
