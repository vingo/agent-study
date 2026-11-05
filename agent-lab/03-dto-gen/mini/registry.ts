/**
 * 工具注册表。
 *
 * 阶段 0 那版是把工具定义写在数组里、执行写在 switch 里，两处分离 ——
 * 加一个工具要改两个地方，而且忘了改 switch 不会报错，只会在运行时
 * 返回「没有这个工具」。这是真实踩过的类型检查抓不到的问题。
 *
 * 注册表把三样收在一处：schema、描述、执行函数。
 * 用 zod 定义入参，顺手解决两件事：
 *   1. 自动转 JSON Schema 给模型，不用手写两份
 *   2. 执行前校验，模型传错参数时给出结构化的错误信息而不是 undefined
 *
 * 设计上有一条克制：不做「工具自动发现」那种魔法。显式注册虽然啰嗦，
 * 但你能一眼看出这个 agent 到底有哪些能力 —— 这在排查「它为什么调了那个工具」
 * 时很关键。
 */
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";

/** 工具执行的返回值。isError 会变成 tool_result 的 is_error */
export interface ToolOutcome {
  content: string;
  isError: boolean;
}

export const ok = (content: string): ToolOutcome => ({ content, isError: false });
export const fail = (content: string): ToolOutcome => ({ content, isError: true });

/**
 * 一个工具的完整定义。
 *
 * TCtx 是调用方自定义的上下文类型（沙箱根目录、数据库连接之类），
 * 由 Registry 统一透传给每个工具 —— 工具不自己去拿全局状态，
 * 这样才能在测试里换掉。
 */
export interface ToolDef<TCtx, TInput = unknown> {
  name: string;
  /**
   * 给模型看的描述。写清「什么时候不该用它」——
   * 模型选错工具的代价比填错参数大，它会浪费一整轮。
   */
  description: string;
  input: z.ZodType<TInput>;
  run: (ctx: TCtx, input: TInput) => Promise<ToolOutcome> | ToolOutcome;
  /**
   * 终止工具。模型调用它就意味着任务结束，循环不再继续。
   * DTO 项目里的 emit_dto 就是这种 —— 它不是「做一件事」，是「交卷」。
   */
  terminal?: boolean;
}

export class Registry<TCtx> {
  private tools = new Map<string, ToolDef<TCtx, any>>();

  add<TInput>(def: ToolDef<TCtx, TInput>): this {
    if (this.tools.has(def.name)) {
      // 重名一定是 bug，早失败好过运行时诡异行为
      throw new Error(`工具 "${def.name}" 重复注册`);
    }
    this.tools.set(def.name, def);
    return this;
  }

  get(name: string): ToolDef<TCtx, any> | undefined {
    return this.tools.get(name);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  isTerminal(name: string): boolean {
    return this.tools.get(name)?.terminal === true;
  }

  /** 转成 Anthropic 的 tools 参数 */
  toSpec(): Anthropic.Tool[] {
    return [...this.tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: z.toJSONSchema(t.input, {
        io: "input",
      }) as Anthropic.Tool.InputSchema,
    }));
  }

  /**
   * 执行一个工具。
   *
   * 三种失败都翻译成给模型的可读指令，而不是抛异常：
   *   工具不存在   → 告诉它有哪些工具可用
   *   参数校验失败 → 告诉它哪个字段错了、该怎么填
   *   执行抛异常   → 摘要错误信息，不吐 stack trace
   *
   * 最后一条尤其重要。工具内部抛异常时最容易偷懒直接 String(e)，
   * 但 stack trace 对模型是纯噪音，它看不懂也没法据此纠正。
   */
  async run(ctx: TCtx, name: string, rawInput: unknown): Promise<ToolOutcome> {
    const def = this.tools.get(name);
    if (!def) {
      return fail(`没有名为 "${name}" 的工具。可用的是：${this.names().join("、")}。`);
    }

    const parsed = def.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      const detail = parsed.error.issues
        .map((i) => `  · ${i.path.join(".") || "(根)"}: ${i.message}`)
        .join("\n");
      return fail(`参数不对，请修正后重试：\n${detail}`);
    }

    try {
      return await def.run(ctx, parsed.data);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(`工具执行失败：${msg.split("\n")[0] ?? msg}`);
    }
  }
}
