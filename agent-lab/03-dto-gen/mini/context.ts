/**
 * 上下文压缩。
 *
 * 问题是真实的：agent 每读一个文件，那个文件的全文就永久留在 messages 里，
 * 后面每一轮都要重新发一遍。读了 5 个文件跑 10 轮，第一个文件被付费 10 次。
 *
 * 这里做两档，代价和效果差很远：
 *
 *   裁剪（trim）  纯本地操作，零成本。把老的 tool_result 内容替换成占位符，
 *                 保留结构（tool_use_id 必须留着，否则消息序列就废了）。
 *                 适合「读过的文件不再需要原文」的场景 —— 我们正是这种。
 *
 *   总结（summarize）调一次模型把老历史压成一段话。要花钱、要时间，
 *                 而且有信息损失风险。只在裁剪不够时用。
 *
 * 默认只开裁剪。这是有意的克制：总结听起来更高级，但它引入了
 * 「压缩过程本身可能出错」这个新failure mode，而裁剪是确定性的。
 * 能用确定性手段解决就别引入模型。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { callModel, DEFAULT_MODEL } from "../src/llm.js";

/** 粗估 token 数。不精确，但判断「要不要压缩」够用了 */
export function roughTokens(messages: Anthropic.MessageParam[]): number {
  const json = JSON.stringify(messages);
  // 中英混合大致 3 字符 1 token，宁可高估
  return Math.ceil(json.length / 3);
}

export interface TrimOptions {
  /** 超过这个估算 token 数才动手 */
  threshold: number;
  /** 最近几轮不动 —— 近期上下文是模型当前推理的依据，裁了会让它失忆 */
  keepRecent: number;
  /** 单条 tool_result 超过多少字符才裁 */
  minSize: number;
}

export const DEFAULT_TRIM: TrimOptions = {
  threshold: 60_000,
  keepRecent: 4,
  minSize: 2_000,
};

export interface TrimReport {
  trimmed: number;
  before: number;
  after: number;
}

/**
 * 把老的大块 tool_result 换成占位符。
 *
 * 关键约束：不能删消息、不能改 tool_use_id，只能替换 content 文本。
 * 删一条消息就会打破 tool_use / tool_result 的配对，下一次调用直接 400 ——
 * 这个约束在 session.repair() 的注释里也提到了，它贯穿整个消息处理。
 *
 * 占位符要写清「为什么没了」和「怎么再拿到」，不是单纯说已省略。
 * 模型看到「需要时用 read_file 重新读取」才知道有退路。
 */
export function trim(
  messages: Anthropic.MessageParam[],
  options: Partial<TrimOptions> = {},
): TrimReport {
  const o = { ...DEFAULT_TRIM, ...options };
  const before = roughTokens(messages);
  if (before < o.threshold) return { trimmed: 0, before, after: before };

  const cutoff = Math.max(0, messages.length - o.keepRecent);
  let trimmed = 0;

  for (let i = 0; i < cutoff; i++) {
    const msg = messages[i]!;
    if (!Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block.type !== "tool_result") continue;
      const content = block.content;
      if (typeof content === "string") {
        if (content.length < o.minSize) continue;
        block.content = `[早前读取的内容已省略（原 ${content.length} 字符）。需要时用工具重新读取。]`;
        trimmed++;
      } else if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "text" && part.text.length >= o.minSize) {
            part.text = `[早前读取的内容已省略（原 ${part.text.length} 字符）。需要时用工具重新读取。]`;
            trimmed++;
          }
        }
      }
    }
  }

  return { trimmed, before, after: roughTokens(messages) };
}

/**
 * 用模型把早期历史压成一段总结。
 *
 * 只在 trim 之后还是太长时才该用。返回一组新的 messages：
 * 一条总结 + 保留的近期消息。
 *
 * 风险明说：总结会丢信息，而且丢的是模型认为不重要的部分 ——
 * 它的判断不一定和你的任务一致。有确定性手段就别走这条。
 */
export async function summarize(
  messages: Anthropic.MessageParam[],
  keepRecent = 4,
): Promise<Anthropic.MessageParam[]> {
  const cutoff = Math.max(0, messages.length - keepRecent);
  if (cutoff <= 1) return messages;

  const old = messages.slice(0, cutoff);
  const recent = messages.slice(cutoff);

  const res = await callModel(
    {
      model: DEFAULT_MODEL,
      max_tokens: 2000,
      system:
        "你在压缩一段 agent 的执行历史。用简洁的要点记录：已经做过什么、" +
        "得到了什么关键结论、还剩什么没做。保留具体的文件名和字段名，" +
        "这些是后续步骤要用的。不要加评论。",
      messages: [
        {
          role: "user",
          content: `压缩这段历史：\n\n${JSON.stringify(old).slice(0, 100_000)}`,
        },
      ],
    },
    { label: "context:summarize" },
  );

  const text = res.content
    .filter((b) => b.type === "text")
    .map((b) => (b.type === "text" ? b.text : ""))
    .join("\n");

  // 注意第一条必须是 user role —— API 要求对话从 user 开始
  return [{ role: "user", content: `[早前的执行历史摘要]\n${text}` }, ...recent];
}
