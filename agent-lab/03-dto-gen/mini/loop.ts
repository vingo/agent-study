/**
 * 循环本体 —— 把注册表、会话、压缩串起来。
 *
 * 和 src/agent.ts 的关系：那份是 DTO 专用的，工具写死、prompt 写死、
 * 终止条件写死。这份把三样都变成参数，代价是多一层抽象。
 *
 * 值不值得取决于你有几个 agent。一个的话 agent.ts 那样更直白 ——
 * 这也是「别急着上框架」那条经验的具体含义：框架的价值在第二个
 * 使用场景出现时才显现，提前抽象只是在猜。
 *
 * 四道终止闸沿用 agent.ts 的设计，那是踩出来的：
 *   maxTurns     轮次上限
 *   maxTerminal  终止工具调用上限（提交三次还不对，再改也是原地打转）
 *   无进展检测    连续重复同样的调用
 *   说完没交卷    end_turn 不代表任务完成，只代表它不想说话了
 */
import type Anthropic from "@anthropic-ai/sdk";
import { callModel, DEFAULT_MODEL } from "../src/llm.js";
import { Registry } from "./registry.js";
import { Session } from "./session.js";
import { trim, roughTokens, type TrimOptions } from "./context.js";

export type StopReason = "done" | "max-turns" | "max-terminal" | "no-progress" | "gave-up";

export type Step =
  | { type: "tool"; name: string; input: unknown; result: string; isError: boolean }
  | { type: "text"; text: string }
  | { type: "terminal"; name: string; ok: boolean; feedback: string }
  | { type: "nudge"; reason: string }
  | { type: "trim"; trimmed: number; before: number; after: number };

/** 终止工具的判定结果。ok=false 时 feedback 会回给模型让它改 */
export interface Verdict {
  ok: boolean;
  feedback: string;
}

export interface RunOptions<TCtx> {
  ctx: TCtx;
  registry: Registry<TCtx>;
  system: string;
  task: string;
  /**
   * 判定终止工具的提交。拿到的是已经通过 zod 校验的入参。
   * 框架不知道什么算「对」，这个必须由调用方给。
   */
  judge: (name: string, input: unknown) => Verdict | Promise<Verdict>;
  session?: Session;
  maxTurns?: number;
  maxTerminal?: number;
  model?: string;
  /** trace 标签 */
  label?: string;
  trim?: Partial<TrimOptions> | false;
  onStep?: (step: Step) => void;
  /** 每轮结束后调用，用来存快照 */
  onTurn?: (session: Session) => Promise<void> | void;
}

export interface RunResult {
  stopReason: StopReason;
  session: Session;
  steps: Step[];
  /** 最后一次终止工具的入参 */
  output?: unknown;
  turns: number;
  terminalCalls: number;
}

function signature(name: string, input: unknown): string {
  return `${name}:${JSON.stringify(input ?? {})}`;
}

export async function run<TCtx>(options: RunOptions<TCtx>): Promise<RunResult> {
  const {
    ctx,
    registry,
    system,
    task,
    judge,
    onStep,
    onTurn,
    label = "mini",
    model = DEFAULT_MODEL,
  } = options;
  const maxTurns = options.maxTurns ?? 12;
  const maxTerminal = options.maxTerminal ?? 3;

  const session = options.session ?? new Session();
  const steps: Step[] = [];

  // 新会话才塞任务；恢复的会话已经有历史了，再塞一遍会让模型重头做
  if (session.messages.length === 0) {
    session.push({ role: "user", content: task });
  } else {
    const repaired = session.repair();
    if (repaired.dropped > 0) {
      steps.push({ type: "nudge", reason: `恢复会话：${repaired.reason}` });
    }
  }

  const emit = (step: Step) => {
    steps.push(step);
    onStep?.(step);
  };

  let terminalCalls = 0;
  let output: unknown;
  let lastVerdictOk = false;
  let repeatOf: string | undefined;
  let repeatCount = 0;
  let nudged = false;

  const finish = (stopReason: StopReason): RunResult => ({
    stopReason,
    session,
    steps,
    output,
    turns: session.turns,
    terminalCalls,
  });

  while (session.turns < maxTurns) {
    session.turns++;

    // 压缩在调用前做，这样省下的是真金白银
    if (options.trim !== false) {
      const report = trim(session.messages, options.trim ?? {});
      if (report.trimmed > 0) emit({ type: "trim", ...report });
    }

    const res = await callModel(
      {
        model,
        max_tokens: 8000,
        system,
        tools: registry.toSpec(),
        messages: session.messages,
      },
      { label },
    );

    session.push({ role: "assistant", content: res.content });

    for (const block of res.content) {
      if (block.type === "text" && block.text.trim()) {
        emit({ type: "text", text: block.text.trim() });
      }
    }

    const toolUses = res.content.filter((b) => b.type === "tool_use");

    // 闸 4：说完了但没交卷
    if (toolUses.length === 0) {
      if (lastVerdictOk) return finish("done");
      if (nudged) return finish("gave-up");
      nudged = true;
      emit({ type: "nudge", reason: "结束了回复但没有调用终止工具" });
      const terminals = registry.names().filter((n) => registry.isTerminal(n));
      session.push({
        role: "user",
        content:
          `你还没有调用终止工具（${terminals.join(" / ")}）提交结果。` +
          `如果已经做完，请现在提交；如果还缺信息，说明缺什么并继续用工具获取。`,
      });
      await onTurn?.(session);
      continue;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUses) {
      if (block.type !== "tool_use") continue;

      // ---- 终止工具 ----
      if (registry.isTerminal(block.name)) {
        terminalCalls++;
        const def = registry.get(block.name)!;
        const parsed = def.input.safeParse(block.input);

        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((i) => `  · ${i.path.join(".") || "(根)"}: ${i.message}`)
            .join("\n");
          emit({ type: "terminal", name: block.name, ok: false, feedback: detail });
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            is_error: true,
            content: `提交不符合 schema，请修正后重新提交：\n${detail}`,
          });
          continue;
        }

        const verdict = await judge(block.name, parsed.data);
        lastVerdictOk = verdict.ok;
        output = parsed.data;
        emit({ type: "terminal", name: block.name, ok: verdict.ok, feedback: verdict.feedback });

        if (verdict.ok) {
          await onTurn?.(session);
          return finish("done");
        }

        // 不合格也要配 tool_result，否则下一轮直接 400
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          is_error: true,
          content: verdict.feedback,
        });
        continue;
      }

      // ---- 普通工具 ----
      const sig = signature(block.name, block.input);
      if (sig === repeatOf) repeatCount++;
      else {
        repeatOf = sig;
        repeatCount = 1;
      }

      const outcome = await registry.run(ctx, block.name, block.input);
      emit({
        type: "tool",
        name: block.name,
        input: block.input,
        result: outcome.content,
        isError: outcome.isError,
      });

      results.push({
        type: "tool_result",
        tool_use_id: block.id,
        is_error: outcome.isError,
        content: outcome.content.slice(0, 40_000),
      });
    }

    session.push({ role: "user", content: results });
    await onTurn?.(session);

    if (terminalCalls >= maxTerminal) return finish("max-terminal");
    if (repeatCount >= 3) return finish("no-progress");
  }

  return finish("max-turns");
}

export { Registry, Session, trim, roughTokens };
