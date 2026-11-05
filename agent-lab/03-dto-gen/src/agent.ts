/**
 * v2 —— 多轮自主循环。
 *
 * 核心还是阶段 0 那五十行：while (模型还想调工具) { 调工具, 结果塞回去 }。
 * v2 在它之上加的是【终止条件】，这是这一步真正的知识点。
 *
 * 为什么终止条件值得单独学：v1 是单轮，天然会结束；多轮循环不会自己停。
 * 模型可能反复读同一个文件、可能提交失败后一直改不对、可能就是不调 emit_dto。
 * 没有终止条件，你得到的是一个烧钱的死循环。
 *
 * 这里设了四道闸：
 *   1. maxTurns      —— 轮次上限，最硬的一道
 *   2. maxEmits      —— 提交失败重试上限。改三次还不对，多半是它理解错了，
 *                       再让它改也是原地打转，不如失败掉让人看
 *   3. 无进展检测     —— 连续重复同样的工具调用就切断。模型卡住的典型表现
 *   4. 结束但没提交   —— 模型自己说完了却没调 emit_dto，要拉回来问一次
 *
 * 第 3 条和第 4 条容易漏。第 4 条尤其反直觉：stop_reason 是 end_turn
 * 不代表任务完成了，只代表它不想再说话了。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { dtoSchema, type DtoSpec } from "./schema.js";
import { TOOLS, runTool, type ToolContext } from "./tools.js";
import { callModel, DEFAULT_MODEL } from "./llm.js";

export const SYSTEM_PROMPT = `你是一个 TypeScript DTO 生成助手。工作目录是一个代码仓库，里面有接口文档和已有的 .interface.ts 文件。你要读文档、抽出 interface 和字段，照着仓库里既有的写法提交。

字段怎么填、类型怎么映射，看 emit_dto 的 schema 描述。下面只讲 schema 里说不清的事。

## 怎么开始

1. list_files 看仓库结构。大仓库先用小 depth 看轮廓，别一次拉全。
2. read_file 读接口文档。
3. 找到这个接口该放的目录，read_file 一到两个同目录的既有文件，看它们的写法。
4. emit_dto 提交，并在 namingStyle 里报告你观察到的命名风格。

第 3 步是重点。不要跳过，也不要读一堆 —— 同目录挑一两个最像的就够了。

## 照着邻居写，不要照着全局习惯写

同一个仓库里不同目录的约定可能不一样。有的目录 \`export interface QueryCityInfoRequestType\`，有的目录 \`export interface IQueryRoomStatusRequestType\`。

判断依据是【目标目录里的邻居文件】，不是你对 TypeScript 的一般印象，也不是仓库里出现最多的那种。文档说这个接口属于哪个 service，就去那个 service 的目录看。

如果目标目录里没有任何既有文件，namingStyle 就不填，让调用方决定。

## 只读需要的，不要通读仓库

用 search_files 定位，别靠 read_file 逐个翻。读文件是有代价的 —— 读进来的每个字都在挤占你处理文档的注意力。

具体来说：
- 想知道某个类型定义在哪 → search_files，不要逐个读文件找
- 想知道命名风格 → 读一两个同目录文件就够，不用读完整个目录
- 和任务无关的目录（测试、配置、构建产物）→ 不要读

## 文档先通读再提交

文档里的 interface 往往互相引用，后面的定义会解释前面的字段。整份读完再提交，不要读一半就动手。

一个具体后果：某个字段的类型是另一个 interface 时，那个 interface 通常在文档后面才定义。别因为读到该字段时还没见过它，就把类型标成 unknown。

## 覆盖完整，一个都不要漏

文档里出现的每一个 interface 都要出现在提交里，包括只被引用一次的嵌套结构。字段同理，按文档里的顺序，一个不少。

这条最容易出问题的地方是长文档的末尾 —— 前面的 interface 字段多，写到后面容易草率收尾。提交前数一遍：文档里有几个 interface，你提交了几个。

## 拿不准就保守，绝对不要编

- 类型看不懂（泛型嵌套、Map、文档里写得含糊）→ 标 unknown，不要猜一个具体类型
- 说明栏是空的 → description 就留空，不要根据字段名替它写一句
- 文档没提必填 → required 填 false

编出来的东西比漏掉的危害大。漏了字段，用的人一眼看到缺；编了字段或编了注释，看起来完全正常，要到线上才发现对不上。

## 照抄，不要顺手修正

文档里的字段名和说明原样搬过来，即使它们看起来有问题：

- 命名风格不统一（一堆小驼峰里混一个 ResponseStatus 大写开头）→ 保持原样，这是接口的真实契约，改了就对不上
- 说明文字有错别字、标点混用、带一长串 URL → 原样照抄
- 同一个字段名在一个 interface 里出现两次 → 两条都提交，保持原样

最后一条值得解释一下：重复字段是文档本身的缺陷，生成的代码会编译不过。这是对的 —— 你如实反映了文档的样子，问题会在编译阶段暴露出来，然后有人去修文档。如果你替它去重，缺陷就被你掩盖了，没人知道文档有问题。

你的职责是忠实转换，不是修复文档。

## 提交后

emit_dto 会自动检查你的输出并把问题返回给你。如果收到问题，对照文档修正后重新提交。
如果你认为返回的问题是文档本身的缺陷（比如上面说的重复字段），在回复里说明原因，不要为了让检查通过而改动文档的真实内容。`;

/** 提交的校验结果。由调用方提供 —— agent 层不关心怎么校验，只关心过没过 */
export interface EmitReview {
  ok: boolean;
  /** 不通过时给模型看的说明。要写成「哪里错了、该怎么改」 */
  feedback: string;
}

export interface AgentOptions {
  ctx: ToolContext;
  /** 第一轮给模型的任务描述 */
  task: string;
  /** 校验一次提交。返回 ok=false 会把 feedback 作为 tool_result 回给模型 */
  review: (spec: DtoSpec) => EmitReview | Promise<EmitReview>;
  maxTurns?: number;
  maxEmits?: number;
  /** 每一步的日志，给 CLI 打进度用 */
  onStep?: (step: AgentStep) => void;
}

export type AgentStep =
  | { type: "tool"; name: string; input: unknown; result: string; isError: boolean }
  | { type: "text"; text: string }
  | { type: "emit"; ok: boolean; feedback: string }
  | { type: "nudge"; reason: string };

export type StopReason =
  | "done"
  | "max-turns"
  | "max-emits"
  | "no-progress"
  | "gave-up";

export interface AgentResult {
  spec?: DtoSpec;
  stopReason: StopReason;
  turns: number;
  emits: number;
  steps: AgentStep[];
  /** 累计 token，成本归因用 —— v6 会认真做，这里先记上 */
  usage: { input: number; output: number };
}

/** 工具调用签名，用来做无进展检测 */
function signature(name: string, input: unknown): string {
  return `${name}:${JSON.stringify(input ?? {})}`;
}

/** 截断给模型看的文本，避免一个巨大文件把上下文顶爆 */
function truncate(s: string, max = 40_000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n\n[内容过长已截断，原文 ${s.length} 字符]`;
}

export async function runAgent(options: AgentOptions): Promise<AgentResult> {
  const { ctx, task, review, onStep } = options;
  const maxTurns = options.maxTurns ?? 12;
  const maxEmits = options.maxEmits ?? 3;

  const messages: Anthropic.MessageParam[] = [{ role: "user", content: task }];
  const steps: AgentStep[] = [];
  const usage = { input: 0, output: 0 };

  let emits = 0;
  let turns = 0;
  let lastSpec: DtoSpec | undefined;
  /**
   * 最后一次提交有没有通过校验。
   *
   * 必须单独记，不能用「有 spec 且提交过」来推断 ——
   * 踩过：模型提交两次都没通过，然后自己结束了回复，
   * 闸 4 里 `lastSpec && emits > 0` 成立，于是报「完成」。
   * 但那份产物是不合格的。有产物不等于成功。
   */
  let lastReviewOk = false;
  /** 最近的工具调用签名，连续相同说明卡住了 */
  let repeatOf: string | undefined;
  let repeatCount = 0;
  /** end_turn 但没提交时推它一次，只推一次 —— 推两次还不动就是真不打算做了 */
  let nudged = false;

  const emit = (step: AgentStep) => {
    steps.push(step);
    onStep?.(step);
  };

  const finish = (stopReason: StopReason): AgentResult => ({
    spec: lastSpec,
    stopReason,
    turns,
    emits,
    steps,
    usage,
  });

  while (turns < maxTurns) {
    turns++;

    const res = await callModel(
      {
        model: DEFAULT_MODEL,
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        messages,
      },
      { label: "agent" },
    );

    usage.input += res.usage.input_tokens;
    usage.output += res.usage.output_tokens;
    messages.push({ role: "assistant", content: res.content });

    for (const block of res.content) {
      if (block.type === "text" && block.text.trim()) {
        emit({ type: "text", text: block.text.trim() });
      }
    }

    const toolUses = res.content.filter((b) => b.type === "tool_use");

    // 闸 4：说完了但没提交。不是「完成」，只是它不想说话了
    if (toolUses.length === 0) {
      if (lastReviewOk) return finish("done");
      if (nudged) return finish("gave-up");
      nudged = true;
      emit({ type: "nudge", reason: "模型结束了回复但没有调用 emit_dto" });
      messages.push({
        role: "user",
        content:
          "你还没有调用 emit_dto 提交结果。如果已经读完文档，请现在提交；" +
          "如果还缺信息，说明缺什么并继续用工具获取。",
      });
      continue;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];

    for (const block of toolUses) {
      if (block.type !== "tool_use") continue;

      // ---- emit_dto：终止信号，走校验 ----
      if (block.name === "emit_dto") {
        emits++;
        const parsed = dtoSchema.safeParse(block.input);

        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((i) => `  · ${i.path.join(".") || "(根)"}: ${i.message}`)
            .join("\n");
          emit({ type: "emit", ok: false, feedback: detail });
          results.push({
            type: "tool_result",
            tool_use_id: block.id,
            is_error: true,
            content: `输出不符合 schema，请修正后重新提交：\n${detail}`,
          });
          continue;
        }

        lastSpec = parsed.data as DtoSpec;
        const verdict = await review(lastSpec);
        lastReviewOk = verdict.ok;
        emit({ type: "emit", ok: verdict.ok, feedback: verdict.feedback });

        if (verdict.ok) {
          // 不用把成功结果回给模型再等它说一句「好了」—— 白花一轮
          return finish("done");
        }

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
      if (sig === repeatOf) {
        repeatCount++;
      } else {
        repeatOf = sig;
        repeatCount = 1;
      }

      const outcome = await runTool(ctx, block.name, block.input);
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
        content: truncate(outcome.content),
      });
    }

    messages.push({ role: "user", content: results });

    // 闸 2：提交次数用尽
    if (emits >= maxEmits) return finish("max-emits");

    // 闸 3：连续三次同样的调用，卡住了
    if (repeatCount >= 3) return finish("no-progress");
  }

  // 闸 1：轮次用尽
  return finish("max-turns");
}
