/**
 * v2 的工具层。
 *
 * 和 v1 的区别：v1 是我把文档内容塞给模型、它一次性返回结构；
 * v2 是给它一组工具，它自己决定读哪个文件、什么时候提交 —— 多轮，它驱动。
 *
 * 工具设计上有两个决定值得说明。
 *
 * 【一】没有 write_file。
 * 看起来 v2 该给它写文件的能力，但让模型直接吐代码字符串是 v1 就否掉的做法：
 * 它会在缩进、引号、分号上犯随机错误，而且你没法校验。
 * 所以提交走 emit_dto —— 模型输出结构化数据，渲染和落盘由代码做，产物是确定的。
 * 「多轮自主」体现在它自己探索、自己决定何时提交，不在于它能不能拼字符串。
 *
 * 【二】emit_dto 会把校验结果回给模型。
 * 提交后跑一遍 verify + assert，不通过就把具体问题作为 tool_result 返回，
 * 让它自己修。这才是 v2 真正的收益：循环闭上了。
 * 这也是阶段 1 那条经验的延续 —— 返回值是给模型的下一步指令，不是数据搬运。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type Anthropic from "@anthropic-ai/sdk";
import { dtoSchema } from "./schema.js";

/**
 * 沙箱根目录。所有文件操作限制在这个目录内。
 *
 * 这不是「以防万一」的防御性代码，是 agent 必须有的边界：
 * 模型会拼路径，而它拼错、或者被文档里的内容引导去读别的东西，
 * 都不该能碰到沙箱外面。阶段 3 有一课专门讲 prompt injection，
 * 这里先把地基打对 —— 权限边界在代码层面卡死，不靠 prompt 里写「请不要读别的文件」。
 */
export interface ToolContext {
  /** 沙箱根，绝对路径 */
  root: string;
}

/** 路径越界 */
export class PathEscapeError extends Error {}

/**
 * 把模型给的相对路径解析成绝对路径，并确认没跑出沙箱。
 *
 * 用 resolve 之后比前缀，而不是检查字符串里有没有 ".." ——
 * 后者能被 "a/../../b"、URL 编码、符号链接绕过。比较解析后的结果才是对的做法。
 */
export function resolveInside(root: string, rel: string): string {
  const abs = path.resolve(root, rel);
  const normalizedRoot = path.resolve(root);
  if (abs !== normalizedRoot && !abs.startsWith(normalizedRoot + path.sep)) {
    throw new PathEscapeError(rel);
  }
  return abs;
}

// ================================================================
// 工具定义
// ================================================================
//
// description 里都带了「什么时候不该用它」—— 这是 v1 阶段 schema 描述的同一个思路，
// 但对工具更重要：模型选错工具的代价比填错字段大，它会浪费一整轮。
// ================================================================

export const TOOLS: Anthropic.Tool[] = [
  {
    name: "list_files",
    description:
      "列出目录下的文件，默认递归。开始任务时先用它看仓库结构，不要凭猜测直接 read_file。" +
      "只需要读一个你已经知道确切路径的文件时，不用先调它。",
    input_schema: {
      type: "object",
      properties: {
        dir: {
          type: "string",
          description: "相对于工作目录的子目录，不传或传 \".\" 表示工作目录本身",
        },
        depth: {
          type: "number",
          description: "递归深度，默认 3。大仓库里先用小深度看轮廓，再往下钻",
        },
      },
    },
  },
  {
    name: "search_files",
    description:
      "在文件内容里搜关键词，返回匹配的文件和行号。" +
      "用它定位「某个类型定义在哪」「哪些文件用了某个字段」——" +
      "比逐个 read_file 省得多。不要用它替代 list_files 看目录结构。",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "要搜的字符串，区分大小写",
        },
        dir: {
          type: "string",
          description: "限定搜索范围的子目录，不传搜整个工作目录",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description:
      "读取一个文件的完整内容。用来读接口文档，也可以读同目录下已有的 .interface.ts " +
      "参考现有命名风格。一次只读一个文件；需要读多个就多次调用。",
    input_schema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "相对于工作目录的文件路径",
        },
      },
      required: ["file"],
    },
  },
  {
    name: "emit_dto",
    description:
      "提交解析好的 DTO 结构，完成任务。提交后会自动做 TypeScript 编译检查和字段核对，" +
      "如果有问题会把具体错误返回给你，你修正后再次调用即可。" +
      "读完文档、确认每个 interface 和字段都齐了再调用 —— 不要分多次提交部分结果，" +
      "每次调用都是一份完整的输出，后一次会覆盖前一次。",
    input_schema: z.toJSONSchema(dtoSchema, { io: "input" }) as Anthropic.Tool.InputSchema,
  },
];

// ================================================================
// 执行
// ================================================================
//
// 所有报错措辞都写成「哪里错了 + 该怎么做」。
// 返回 ENOENT 或者 stack trace 模型只会干瞪眼，告诉它「这个文件不存在，
// 当前目录下有 a.md b.md」它下一轮就能自己纠正。
// ================================================================

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

function ok(content: string): ToolOutcome {
  return { content, isError: false };
}

function err(content: string): ToolOutcome {
  return { content, isError: true };
}

/** 不进这些目录 —— 省上下文，也避免把 node_modules 整个抖出来 */
const SKIP_DIRS = new Set(["node_modules", "dist", "build", "coverage", "out"]);

/** 递归列目录。返回相对 base 的路径 */
async function walk(base: string, rel: string, depth: number, acc: string[]): Promise<void> {
  if (depth < 0 || acc.length > 400) return;
  const entries = await fs.readdir(path.join(base, rel), { withFileTypes: true });
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
    const childRel = rel === "." ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      acc.push(`${childRel}/`);
      await walk(base, childRel, depth - 1, acc);
    } else {
      acc.push(childRel);
    }
  }
}

async function listFiles(
  ctx: ToolContext,
  input: { dir?: string; depth?: number },
): Promise<ToolOutcome> {
  const rel = input.dir?.trim() || ".";
  const depth = Math.max(0, Math.min(Number(input.depth ?? 3), 8));

  let abs: string;
  try {
    abs = resolveInside(ctx.root, rel);
  } catch {
    return err(`路径 "${rel}" 超出了工作目录，只能访问工作目录内的文件。请用相对路径。`);
  }

  try {
    const acc: string[] = [];
    await walk(abs, ".", depth, acc);
    if (acc.length === 0) return ok(`${rel} 是空目录。`);
    const capped = acc.length > 400;
    const body = acc.slice(0, 400).join("\n");
    return ok(capped ? `${body}\n[结果过多已截断，用 dir 参数缩小范围]` : body);
  } catch {
    return err(`目录 "${rel}" 不存在。先用 list_files 不带参数看看工作目录里有什么。`);
  }
}

/** 搜内容。返回文件:行号 + 该行内容，不返回整个文件 —— 这是控上下文的关键 */
async function searchFiles(
  ctx: ToolContext,
  input: { query?: string; dir?: string },
): Promise<ToolOutcome> {
  const query = input.query?.trim();
  if (!query) return err(`缺少 query 参数。传一个要搜的字符串，比如 "ResponseStatusType"。`);

  const rel = input.dir?.trim() || ".";
  let abs: string;
  try {
    abs = resolveInside(ctx.root, rel);
  } catch {
    return err(`路径 "${rel}" 超出了工作目录，只能访问工作目录内的文件。请用相对路径。`);
  }

  const files: string[] = [];
  try {
    await walk(abs, ".", 8, files);
  } catch {
    return err(`目录 "${rel}" 不存在。`);
  }

  const hits: string[] = [];
  for (const f of files) {
    if (f.endsWith("/")) continue;
    let content: string;
    try {
      content = await fs.readFile(path.join(abs, f), "utf8");
    } catch {
      continue; // 二进制或权限问题，跳过
    }
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(query)) {
        const where = rel === "." ? f : `${rel}/${f}`;
        hits.push(`${where}:${i + 1}: ${lines[i]!.trim().slice(0, 120)}`);
        if (hits.length >= 60) break;
      }
    }
    if (hits.length >= 60) break;
  }

  if (hits.length === 0) {
    return ok(`没有匹配 "${query}" 的内容。换个更短的关键词，或用 list_files 确认搜索范围。`);
  }
  return ok(hits.join("\n"));
}

async function readFile(ctx: ToolContext, input: { file?: string }): Promise<ToolOutcome> {
  const rel = input.file?.trim();
  if (!rel) return err(`缺少 file 参数。传一个相对于工作目录的文件路径，比如 "queryCityInfo.md"。`);

  let abs: string;
  try {
    abs = resolveInside(ctx.root, rel);
  } catch {
    return err(`路径 "${rel}" 超出了工作目录，只能访问工作目录内的文件。请用相对路径。`);
  }

  try {
    const content = await fs.readFile(abs, "utf8");
    if (!content.trim()) return ok(`${rel} 是空文件。`);
    return ok(content);
  } catch {
    // 报错里带上实际有哪些文件 —— 模型下一轮就能自己改对，省一轮试错
    try {
      const siblings = await fs.readdir(path.dirname(abs));
      const visible = siblings.filter((f) => !f.startsWith(".")).join(", ");
      return err(`文件 "${rel}" 不存在。同目录下有：${visible}`);
    } catch {
      return err(`文件 "${rel}" 不存在，且它所在的目录也不存在。用 list_files 确认路径。`);
    }
  }
}

/** 分发。emit_dto 不在这里处理 —— 它是终止信号，由循环自己接管 */
export async function runTool(
  ctx: ToolContext,
  name: string,
  input: unknown,
): Promise<ToolOutcome> {
  const args = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "list_files":
      return listFiles(ctx, args as { dir?: string; depth?: number });
    case "search_files":
      return searchFiles(ctx, args as { query?: string; dir?: string });
    case "read_file":
      return readFile(ctx, args as { file?: string });
    default:
      return err(
        `没有名为 "${name}" 的工具。可用的是：list_files、search_files、read_file、emit_dto。`,
      );
  }
}
