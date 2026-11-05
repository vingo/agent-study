/**
 * 三个编排范式的最小实现，跑同一个任务，用来对比。
 *
 * 写它们的目的不是「学会」——三个都只有几十行，没什么可学的。
 * 目的是拿到数据回答一个问题：这个任务需要哪一种？
 *
 * 先说结论，代码在下面验证：
 *
 *   ReAct             我们的 v2/v3 已经是它了。agent.ts 那个循环
 *                     「想 → 调工具 → 看结果 → 再想」就是 ReAct，
 *                     只是没人在代码里写 "react" 这个词。
 *
 *   Plan-and-Execute  先让模型列计划，再按计划执行。
 *                     适合任务结构不确定、需要先拆解的场景。
 *                     这个任务的结构是固定的（读文档 → 读参考 → 提交），
 *                     让模型现场想一遍步骤纯属多花一次调用。
 *
 *   Reflexion         提交后让模型自我批评，再据此修正。
 *                     适合【没有客观判据】的场景（写文案、出方案）。
 *                     我们有编译器和断言 —— 客观判据已经有了，
 *                     让模型猜自己哪里错了，是在用劣质信号替代好信号。
 *
 * 最后一条是这一课真正的收获：Reflexion 不是更高级的 ReAct，
 * 它是在你拿不到 oracle 时的退路。能写出断言就别用它。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { dtoSchema, type DtoSpec } from "./schema.js";
import { TOOLS, runTool, type ToolContext } from "./tools.js";
import { SYSTEM_PROMPT } from "./agent.js";
import { callModel, DEFAULT_MODEL } from "./llm.js";

export interface PatternResult {
  spec?: DtoSpec;
  /** 总的模型调用次数 —— 这是对比的关键指标，不是轮次 */
  calls: number;
  usage: { input: number; output: number };
  /** 范式特有的中间产物，用来看它到底多做了什么 */
  notes: string[];
}

export interface PatternOptions {
  ctx: ToolContext;
  task: string;
  /** 客观判据。Reflexion 那个实现里故意不给它用，用来演示差别 */
  review: (spec: DtoSpec) => { ok: boolean; feedback: string };
  maxCalls?: number;
}

/** 跑一次 messages.create 并累计用量 */
async function call(
  messages: Anthropic.MessageParam[],
  acc: PatternResult,
  opts: {
    system?: string;
    tools?: Anthropic.Tool[];
    forceTool?: string;
    /** trace 分组标签，用来看各范式的成本构成 */
    label?: string;
  } = {},
): Promise<Anthropic.Message> {
  const res = await callModel(
    {
      model: DEFAULT_MODEL,
      max_tokens: 8000,
      system: opts.system ?? SYSTEM_PROMPT,
      ...(opts.tools ? { tools: opts.tools } : {}),
      ...(opts.forceTool
        ? { tool_choice: { type: "tool" as const, name: opts.forceTool } }
        : {}),
      messages,
    },
    { label: opts.label ?? "pattern" },
  );
  acc.calls++;
  acc.usage.input += res.usage.input_tokens;
  acc.usage.output += res.usage.output_tokens;
  messages.push({ role: "assistant", content: res.content });
  return res;
}

/** 执行 assistant 这一轮里的所有工具调用，返回 tool_result 和是否拿到了 spec */
async function handleTools(
  ctx: ToolContext,
  res: Anthropic.Message,
): Promise<{ results: Anthropic.ToolResultBlockParam[]; spec?: DtoSpec; emitId?: string }> {
  const results: Anthropic.ToolResultBlockParam[] = [];
  let spec: DtoSpec | undefined;
  let emitId: string | undefined;

  for (const block of res.content) {
    if (block.type !== "tool_use") continue;

    if (block.name === "emit_dto") {
      const parsed = dtoSchema.safeParse(block.input);
      emitId = block.id;
      if (parsed.success) {
        spec = parsed.data as DtoSpec;
      } else {
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          is_error: true,
          content: "输出不符合 schema，请修正后重新提交。",
        });
      }
      continue;
    }

    const outcome = await runTool(ctx, block.name, block.input);
    results.push({
      type: "tool_result",
      tool_use_id: block.id,
      is_error: outcome.isError,
      content: outcome.content.slice(0, 40_000),
    });
  }

  return { results, spec, emitId };
}

// ================================================================
// 1. ReAct
// ================================================================
//
// 这就是 agent.ts 里那个循环，剥掉终止条件和日志之后的样子。
// 写在这里只为了对比时有个同源的基线 —— 生产上用 agent.ts 那版，
// 它有四道终止闸，这版只有 maxCalls。
// ================================================================

export async function react(opts: PatternOptions): Promise<PatternResult> {
  const { ctx, task, review } = opts;
  const maxCalls = opts.maxCalls ?? 12;
  const acc: PatternResult = { calls: 0, usage: { input: 0, output: 0 }, notes: [] };
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];

  while (acc.calls < maxCalls) {
    const res = await call(messages, acc, { tools: TOOLS, label: "react" });
    const { results, spec, emitId } = await handleTools(ctx, res);

    if (spec) {
      const verdict = review(spec);
      if (verdict.ok) {
        acc.spec = spec;
        return acc;
      }
      acc.spec = spec; // 留着，即使不合格
      results.push({
        type: "tool_result",
        tool_use_id: emitId!,
        is_error: true,
        content: verdict.feedback,
      });
    }

    if (results.length === 0) return acc; // 没调工具也没提交，停
    messages.push({ role: "user", content: results });
  }

  return acc;
}

// ================================================================
// 2. Plan-and-Execute
// ================================================================
//
// 先让模型产出一份计划，再带着计划去执行。
//
// 实现上要注意一点：计划必须【结构化】产出，不能让它写一段散文然后
// 指望后面的执行阶段读懂。用工具强制它输出步骤数组，这是 v1 学的东西。
// ================================================================

const planSchema = z.object({
  steps: z
    .array(z.string())
    .min(1)
    .max(8)
    .describe("执行步骤，每条一句话，具体到调用哪个工具、看哪个文件"),
});

export async function planAndExecute(opts: PatternOptions): Promise<PatternResult> {
  const { ctx, task, review } = opts;
  const maxCalls = opts.maxCalls ?? 12;
  const acc: PatternResult = { calls: 0, usage: { input: 0, output: 0 }, notes: [] };

  // ---- 阶段一：规划。单独一次调用，不给工具 ----
  const planMessages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `${task}\n\n先不要动手。列出你打算执行的步骤。` +
        `可用工具：list_files、search_files、read_file、emit_dto。`,
    },
  ];
  const planRes = await call(planMessages, acc, {
    tools: [
      {
        name: "emit_plan",
        description: "输出执行计划",
        input_schema: z.toJSONSchema(planSchema, { io: "input" }) as Anthropic.Tool.InputSchema,
      },
    ],
    forceTool: "emit_plan",
    label: "plan-execute:plan",
  });

  const planBlock = planRes.content.find((b) => b.type === "tool_use");
  const plan = planBlock?.type === "tool_use" ? planSchema.safeParse(planBlock.input) : undefined;
  const steps = plan?.success ? plan.data.steps : [];
  acc.notes.push(...steps.map((s, i) => `计划 ${i + 1}. ${s}`));

  // ---- 阶段二：执行。把计划作为上下文带进去 ----
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `${task}\n\n你已经制定了这个计划，按它执行：\n` +
        steps.map((s, i) => `${i + 1}. ${s}`).join("\n"),
    },
  ];

  while (acc.calls < maxCalls) {
    const res = await call(messages, acc, { tools: TOOLS, label: "plan-execute:exec" });
    const { results, spec, emitId } = await handleTools(ctx, res);

    if (spec) {
      const verdict = review(spec);
      acc.spec = spec;
      if (verdict.ok) return acc;
      results.push({
        type: "tool_result",
        tool_use_id: emitId!,
        is_error: true,
        content: verdict.feedback,
      });
    }

    if (results.length === 0) return acc;
    messages.push({ role: "user", content: results });
  }

  return acc;
}

// ================================================================
// 3. Reflexion
// ================================================================
//
// 提交之后，让模型自己回头批评一遍，再根据批评修正。
//
// 这个实现里有一个【故意的】设计，是整个对比的关键：
// 自我批评阶段【不】给它编译和断言的结果，只让它凭自己看。
//
// 为什么故意这样：Reflexion 的适用场景是拿不到客观判据的任务
// （写文案、出设计方案 —— 没有编译器能告诉你好不好）。
// 如果把断言结果喂给它，那就不是 Reflexion 了，那是 ReAct 加了个反馈工具，
// 也就是我们 v2 已经在做的事。
//
// 所以这里的对照实验是：客观判据 vs 模型自省，哪个更能发现问题。
// 结果见 npm run compare。
//
// ================================================================
// 【读完论文后的更正 —— 上面那段理解是错的】
// ================================================================
//
// 读 Shinn et al. 2023 原文后发现，Reflexion 的架构是三个角色：
//   Actor           生成动作
//   Evaluator       打分。编程任务上用的正是【单元测试】—— 客观判据
//   Self-Reflection 把分数翻译成自然语言教训，存进 episodic memory
//
// 所以 Reflexion 不是「拿不到客观判据时的退路」，恰好相反：
// 它需要 Evaluator，效果上限由 Evaluator 质量决定。
// 论文自己给了反例 —— MBPP Python 上 Reflexion 低于 GPT-4 基线，
// 原因是自生成单测假阳性率太高。论文结论是「框架对评估质量有依赖」。
//
// 下面这个 reflexionBlind 是我按错误理解写的版本（故意不给它看判据），
// 保留它是因为它恰好演示了「劣质 Evaluator 会发生什么」——
// 实测它把自己填对的 namingStyle 判成了错的。
//
// 按论文架构的正确实现是 reflexionOracle，在它下面。
// ================================================================

const critiqueSchema = z.object({
  hasProblems: z.boolean().describe("是否发现了问题"),
  critique: z.string().describe("发现的问题，没有就写「没有发现问题」"),
});

export async function reflexionBlind(opts: PatternOptions): Promise<PatternResult> {
  const { ctx, task, review } = opts;
  const maxCalls = opts.maxCalls ?? 14;
  const maxReflections = 2;
  const acc: PatternResult = { calls: 0, usage: { input: 0, output: 0 }, notes: [] };
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];

  let reflections = 0;

  while (acc.calls < maxCalls) {
    const res = await call(messages, acc, { tools: TOOLS, label: "reflexion:act" });
    const { results, spec, emitId } = await handleTools(ctx, res);

    if (spec) {
      acc.spec = spec;

      // ---- 自省阶段：不看编译结果，让它自己批评自己 ----
      if (reflections < maxReflections) {
        reflections++;
        // 关键：messages 末尾是带 emit_dto tool_use 的 assistant 消息，
        // 必须先给它配一个 tool_result 才能再追加 user 消息。
        // 少了这个 API 直接 400 —— 踩过，而且报错信息指向的是消息序号，
        // 不是「你少了个 tool_result」，排查得自己数消息。
        // tool_result 和自省指令要合进【同一条】user 消息：
        // 既满足「tool_use 后紧跟 tool_result」，也避免连续两条 user 消息。
        const critiqueMessages: Anthropic.MessageParam[] = [
          ...messages,
          {
            role: "user",
            content: [
              ...results,
              {
                type: "tool_result" as const,
                tool_use_id: emitId!,
                content: "已收到提交。",
              },
              {
                type: "text" as const,
                text:
                  `先不要看任何检查结果 —— 回头重新核对一遍文档，` +
                  `自己找出遗漏或错误的地方。逐个 interface、逐个字段对照，` +
                  `特别注意有没有漏掉整个 interface。`,
              },
            ],
          },
        ];
        const cRes = await call(critiqueMessages, acc, {
          tools: [
            {
              name: "emit_critique",
              description: "报告自我核对的结果",
              input_schema: z.toJSONSchema(critiqueSchema, {
                io: "input",
              }) as Anthropic.Tool.InputSchema,
            },
          ],
          forceTool: "emit_critique",
          label: "reflexion:critique",
        });

        const cBlock = cRes.content.find((b) => b.type === "tool_use");
        const parsed =
          cBlock?.type === "tool_use" ? critiqueSchema.safeParse(cBlock.input) : undefined;

        if (parsed?.success && parsed.data.hasProblems) {
          acc.notes.push(`自省 ${reflections}：${parsed.data.critique.slice(0, 200)}`);
          // 注意这里的 tool_result 挂在【主循环】的 messages 上，
          // 上面那次自省调用用的是独立的 critiqueMessages 副本，没污染主线
          results.push({
            type: "tool_result",
            tool_use_id: emitId!,
            is_error: true,
            content: `你自己核对后发现的问题：\n${parsed.data.critique}\n\n请修正后重新提交。`,
          });
          messages.push({ role: "user", content: results });
          continue;
        }
        acc.notes.push(`自省 ${reflections}：没有发现问题`);
      }

      // 自省说没问题了，最后才用客观判据看看真的没问题吗
      const verdict = review(spec);
      if (verdict.ok) return acc;

      // 踩过的坑：自省通过但客观检查失败时，emit_dto 那个 tool_use
      // 必须配一个 tool_result，否则下一次 API 调用直接 400。
      // 「每个 tool_use 后面必须紧跟 tool_result」是硬约束，
      // 不管你的业务逻辑走了哪个分支。

      acc.notes.push(`自省说没问题，但客观检查发现：${verdict.feedback.slice(0, 200)}`);
      results.push({
        type: "tool_result",
        tool_use_id: emitId!,
        is_error: true,
        content: verdict.feedback,
      });
    }

    if (results.length === 0) return acc;
    messages.push({ role: "user", content: results });
  }

  return acc;
}

// ================================================================
// 3b. Reflexion（按论文架构）
// ================================================================
//
// 三个角色分开，和论文 Figure 1 对齐：
//
//   Actor            跑工具循环、提交结果          —— 复用 review 之外的部分
//   Evaluator        编译器 + 断言                 —— 就是传入的 review，客观判据
//   Self-Reflection  把 Evaluator 的报错翻译成教训  —— 单独一次模型调用
//
// 和 reflexionBlind 的关键差别：自省阶段【看得到】Evaluator 的具体报错。
// 它的工作不是「找出哪里错了」（那是 Evaluator 的事），
// 而是「从错误里提炼出下次该注意什么」。
//
// 和 react 的关键差别：react 直接把报错原文塞回去让模型改；
// 这里多一步提炼，把教训存进 memory 累积。论文的主张是提炼后的
// 自然语言教训比原始报错更有指导性，尤其在多轮试错时。
//
// 这个主张在我们的任务上成立吗？这正是要测的 —— 多一次调用换来什么。
// ================================================================

const reflectionSchema = z.object({
  lesson: z
    .string()
    .describe(
      "从这次失败里提炼的教训，一到两句话。要写成下次动手前该记住的原则，" +
        "不是重复错误内容。比如「提交前要数一遍文档里有几个 interface」" +
        "而不是「我漏了 UserInfo」。",
    ),
  nextAction: z.string().describe("下一步具体要做什么来修正"),
});

export async function reflexionOracle(opts: PatternOptions): Promise<PatternResult> {
  const { ctx, task, review } = opts;
  const maxCalls = opts.maxCalls ?? 14;
  const acc: PatternResult = { calls: 0, usage: { input: 0, output: 0 }, notes: [] };
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];

  /** episodic memory —— 论文的核心组件。累积的教训，每轮都带上 */
  const memory: string[] = [];

  while (acc.calls < maxCalls) {
    // 把累积的教训作为 system 的一部分注入。
    // 论文是加在 Actor 的上下文里，这里放 system 尾部效果相同且更省 token
    const system =
      memory.length === 0
        ? SYSTEM_PROMPT
        : `${SYSTEM_PROMPT}\n\n## 你在之前的尝试中学到的教训\n\n` +
          memory.map((m, i) => `${i + 1}. ${m}`).join("\n");

    const res = await call(messages, acc, {
      system,
      tools: TOOLS,
      label: "reflexion-oracle:act",
    });
    const { results, spec, emitId } = await handleTools(ctx, res);

    if (spec) {
      acc.spec = spec;

      // ---- Evaluator：客观判据，不是模型 ----
      const verdict = review(spec);
      if (verdict.ok) return acc;

      // ---- Self-Reflection：把报错翻译成教训 ----
      // 注意它看得到 verdict.feedback，这是和 reflexionBlind 的根本差别
      const reflectRes = await call(
        [
          {
            role: "user",
            content:
              `你在做一个接口文档转 TypeScript DTO 的任务，刚提交的结果没通过检查。\n\n` +
              `检查器报告：\n${verdict.feedback}\n\n` +
              `你提交的内容（截断）：\n${JSON.stringify(spec).slice(0, 4000)}\n\n` +
              `提炼一条教训，说明下次动手前该注意什么，以及这次具体要怎么改。`,
          },
        ],
        acc,
        {
          system:
            "你在帮一个 agent 从失败里总结经验。教训要具体、可执行，" +
            "指向做事的方式而不是重复错误内容。",
          tools: [
            {
              name: "emit_reflection",
              description: "输出提炼的教训",
              input_schema: z.toJSONSchema(reflectionSchema, {
                io: "input",
              }) as Anthropic.Tool.InputSchema,
            },
          ],
          forceTool: "emit_reflection",
          label: "reflexion-oracle:reflect",
        },
      );

      const rBlock = reflectRes.content.find((b) => b.type === "tool_use");
      const parsed =
        rBlock?.type === "tool_use" ? reflectionSchema.safeParse(rBlock.input) : undefined;

      if (parsed?.success) {
        memory.push(parsed.data.lesson);
        acc.notes.push(`教训：${parsed.data.lesson}`);
        results.push({
          type: "tool_result",
          tool_use_id: emitId!,
          is_error: true,
          content:
            `${verdict.feedback}\n\n` +
            `你总结的教训：${parsed.data.lesson}\n下一步：${parsed.data.nextAction}`,
        });
      } else {
        // 提炼失败就退化成 react 的行为，别让流程卡死
        results.push({
          type: "tool_result",
          tool_use_id: emitId!,
          is_error: true,
          content: verdict.feedback,
        });
      }
    }

    if (results.length === 0) return acc;
    messages.push({ role: "user", content: results });
  }

  return acc;
}

export const PATTERNS = {
  react,
  "plan-execute": planAndExecute,
  "reflexion-blind": reflexionBlind,
  "reflexion-oracle": reflexionOracle,
} as const;

export type PatternName = keyof typeof PATTERNS;
