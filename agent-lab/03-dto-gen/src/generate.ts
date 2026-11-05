/**
 * 阶段 2 · v1 —— 结构化输出 + 校验 + 重试。
 *
 * 已经给你的：tool use 强制结构化输出的机制、校验失败带错误信息重试的循环。
 * 留给你的：SYSTEM_PROMPT。
 *
 * 重试循环为什么这么写，值得看一眼：
 * 校验失败时不是简单地「再问一次」，而是把 zod 的错误信息原文喂回给模型。
 * 这和你在 MCP 工具里写的错误措辞是同一个原理 ——
 * 告诉它「哪里错了、该怎么改」，它才能自我纠正；只说「格式不对」它只会再猜一次。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { dtoSchema, type DtoSpec } from "./schema.js";
import { callModel, DEFAULT_MODEL } from "./llm.js";

const MAX_ATTEMPTS = 3;

// ================================================================
// SYSTEM_PROMPT
// ================================================================
//
// 写之前先分清一件事：规则有两个落点，放错地方就白写。
//
//   schema 的 .describe()  —— 字段级的局部规则。它紧贴着字段，模型填那个
//                             字段时一定会读到，命中率最高。类型映射、命名
//                             约定、嵌套怎么拆，全在 schema.ts 里了。
//   SYSTEM_PROMPT（这里）   —— 跨字段的全局原则。schema 没法表达的东西：
//                             拿不准时的取舍、文档本身有问题时怎么办。
//
// 所以这段刻意写得短。把已经在 schema 里的类型映射表在这儿再抄一遍，
// 不会让它更准，只会占注意力 —— 上下文的稀缺资源是注意力，不是 token。
//
// 另一条：prompt 是给模型读的，不是给自己记笔记的。
// 写「合法性由 verify.ts 管」这种话，模型不知道 verify.ts 是什么，纯噪音。
// ================================================================

const SYSTEM_PROMPT = `你的任务是把接口文档转成 TypeScript DTO 结构，通过 emit_dto 工具输出。

字段怎么填、类型怎么映射、命名什么约定，看 emit_dto 的 schema 描述。下面只讲 schema 里说不清的事。

## 先通读再输出

文档里的 interface 往往互相引用，后面的定义会解释前面的字段。一次性读完再动手，不要边读边填。

一个具体后果：某个字段的类型是另一个 interface 时，那个 interface 通常在文档后面才定义。别因为读到该字段时还没见过它，就把类型标成 unknown。

## 覆盖完整，一个都不要漏

文档里出现的每一个 interface 都要出现在输出里，包括只被引用一次的嵌套结构。字段同理，按文档里的顺序，一个不少。

这条最容易出问题的地方是长文档的末尾 —— 前面的 interface 字段多，写到后面容易草率收尾。输出前数一遍：文档里有几个 interface，你输出了几个。

## 拿不准就保守，绝对不要编

- 类型看不懂（泛型嵌套、Map、文档里写得含糊）→ 标 unknown，不要猜一个具体类型
- 说明栏是空的 → description 就留空，不要根据字段名替它写一句
- 文档没提必填 → required 填 false

编出来的东西比漏掉的危害大。漏了字段，用的人一眼看到缺；编了字段或编了注释，看起来完全正常，要到线上才发现对不上。

## 照抄，不要顺手修正

文档里的字段名和说明原样搬过来，即使它们看起来有问题：

- 命名风格不统一（一堆小驼峰里混一个 ResponseStatus 大写开头）→ 保持原样，这是接口的真实契约，改了就对不上
- 说明文字有错别字、标点混用、带一长串 URL → 原样照抄
- 同一个字段名在一个 interface 里出现两次 → 两条都输出，保持原样

最后一条值得解释一下：重复字段是文档本身的缺陷，生成的代码会编译不过。这是对的 —— 你如实反映了文档的样子，问题会在编译阶段暴露出来，然后有人去修文档。如果你替它去重，缺陷就被你掩盖了，没人知道文档有问题。

你的职责是忠实转换，不是修复文档。`;

/** 把 zod schema 转成 Anthropic tool 的 input_schema */
function toolFromSchema() {
  return {
    name: "emit_dto",
    description: "输出解析好的 DTO 结构。必须调用这个工具，不要用普通文本回复。",
    input_schema: z.toJSONSchema(dtoSchema, { io: "input" }) as Anthropic.Tool.InputSchema,
  };
}

export interface GenerateResult {
  spec: DtoSpec;
  attempts: number;
  /** 每次校验失败的原因，用来观察模型常犯什么错 */
  failures: string[];
}

export async function generate(doc: string): Promise<GenerateResult> {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `把下面这段接口文档转成 TypeScript DTO：\n\n${doc}` },
  ];
  const failures: string[] = [];

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const res = await callModel(
      {
        model: DEFAULT_MODEL,
        max_tokens: 8000,
        system: SYSTEM_PROMPT,
        tools: [toolFromSchema()],
        // 强制它必须调工具，不给它用自由文本回复的选项 ——
        // 这是「结构化输出」的关键开关，少了它模型有时会用 markdown 代码块回答
        tool_choice: { type: "tool", name: "emit_dto" },
        messages,
      },
      // 重试轮次进 label，这样 trace 里能看出「第几次才对」
      { label: attempt === 1 ? "generate" : `generate:retry${attempt - 1}` },
    );

    const block = res.content.find((b) => b.type === "tool_use");
    if (!block || block.type !== "tool_use") {
      failures.push("模型没有调用 emit_dto 工具");
      messages.push({ role: "assistant", content: res.content });
      messages.push({ role: "user", content: "你必须调用 emit_dto 工具输出结果，不要用文本回复。" });
      continue;
    }

    const parsed = dtoSchema.safeParse(block.input);
    if (parsed.success) {
      return { spec: parsed.data as DtoSpec, attempts: attempt, failures };
    }

    // 校验失败：把 zod 的具体错误喂回去，让模型自己修
    const detail = parsed.error.issues
      .map((i) => `  · ${i.path.join(".") || "(根)"}: ${i.message}`)
      .join("\n");
    failures.push(detail);

    messages.push({ role: "assistant", content: res.content });
    messages.push({
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: block.id,
          is_error: true,
          content: `输出不符合 schema，请修正后重新调用 emit_dto：\n${detail}`,
        },
      ],
    });
  }

  throw new Error(
    `${MAX_ATTEMPTS} 次尝试都没能得到合法输出。历史错误：\n${failures.join("\n---\n")}`,
  );
}
