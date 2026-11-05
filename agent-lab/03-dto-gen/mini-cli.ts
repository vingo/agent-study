/**
 * 毕业测试：用 mini/ 框架跑主线项目的 v2/v3 场景。
 *
 * 跑：npm run mini -- fixtures/repo src/common/api/docs/refundOrder.md
 *     npm run mini -- fixtures/repo --resume .sessions/xxx.json
 *
 * 这个文件的意义是证明 mini/ 不是玩具 —— 同样的任务、同样的两道关，
 * 换掉循环实现，结果应该一致。
 *
 * 顺带演示框架本身的价值：业务代码（工具定义 + judge）和
 * 循环机制（终止条件、压缩、快照）彻底分开了。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { dtoSchema, type DtoSpec } from "./src/schema.js";
import { render, externalTypes, type NamingStyle } from "./src/render.js";
import { verify } from "./src/verify.js";
import { assertSpec } from "./src/assert.js";
import { resolveInside } from "./src/tools.js";
import { formatSummary } from "./src/llm.js";
import { Registry, ok, fail } from "./mini/registry.js";
import { Session } from "./mini/session.js";
import { run, type Step } from "./mini/loop.js";
import { SYSTEM_PROMPT } from "./src/agent.js";

const SESSION_DIR = ".sessions";

interface Ctx {
  root: string;
}

// ================================================================
// 工具注册 —— 和 src/tools.ts 同样的三个能力，但定义方式不同：
// schema、描述、执行收在一处，不再分散在数组和 switch 两边
// ================================================================

const SKIP = new Set(["node_modules", "dist", "build", "out", ".git"]);

async function walk(base: string, rel: string, depth: number, acc: string[]): Promise<void> {
  if (depth < 0 || acc.length > 400) return;
  const entries = await fs.readdir(path.join(base, rel), { withFileTypes: true });
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (e.name.startsWith(".") || SKIP.has(e.name)) continue;
    const child = rel === "." ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) {
      acc.push(`${child}/`);
      await walk(base, child, depth - 1, acc);
    } else acc.push(child);
  }
}

const registry = new Registry<Ctx>()
  .add({
    name: "list_files",
    description:
      "列出目录下的文件，默认递归。开始任务时先用它看仓库结构。" +
      "已经知道确切路径时不用先调它。",
    input: z.object({
      dir: z.string().default(".").describe("相对工作目录的子目录"),
      depth: z.number().int().min(0).max(8).default(3).describe("递归深度"),
    }),
    async run(ctx, { dir, depth }) {
      let abs: string;
      try {
        abs = resolveInside(ctx.root, dir);
      } catch {
        return fail(`路径 "${dir}" 超出工作目录，只能访问工作目录内的文件。`);
      }
      try {
        const acc: string[] = [];
        await walk(abs, ".", depth, acc);
        return acc.length === 0 ? ok(`${dir} 是空目录。`) : ok(acc.slice(0, 400).join("\n"));
      } catch {
        return fail(`目录 "${dir}" 不存在。先用 list_files 看工作目录。`);
      }
    },
  })
  .add({
    name: "search_files",
    description:
      "在文件内容里搜关键词，返回文件:行号。用它定位类型定义在哪，比逐个 read_file 省得多。",
    input: z.object({
      query: z.string().min(1).describe("要搜的字符串，区分大小写"),
      dir: z.string().default(".").describe("限定范围的子目录"),
    }),
    async run(ctx, { query, dir }) {
      let abs: string;
      try {
        abs = resolveInside(ctx.root, dir);
      } catch {
        return fail(`路径 "${dir}" 超出工作目录。`);
      }
      const files: string[] = [];
      try {
        await walk(abs, ".", 8, files);
      } catch {
        return fail(`目录 "${dir}" 不存在。`);
      }
      const hits: string[] = [];
      for (const f of files) {
        if (f.endsWith("/")) continue;
        let text: string;
        try {
          text = await fs.readFile(path.join(abs, f), "utf8");
        } catch {
          continue;
        }
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && hits.length < 60; i++) {
          if (lines[i]!.includes(query)) {
            hits.push(
              `${dir === "." ? f : `${dir}/${f}`}:${i + 1}: ${lines[i]!.trim().slice(0, 120)}`,
            );
          }
        }
        if (hits.length >= 60) break;
      }
      return hits.length === 0
        ? ok(`没有匹配 "${query}" 的内容。换个更短的关键词。`)
        : ok(hits.join("\n"));
    },
  })
  .add({
    name: "read_file",
    description: "读取一个文件的完整内容。一次只读一个；要读多个就多次调用。",
    input: z.object({ file: z.string().min(1).describe("相对工作目录的文件路径") }),
    async run(ctx, { file }) {
      let abs: string;
      try {
        abs = resolveInside(ctx.root, file);
      } catch {
        return fail(`路径 "${file}" 超出工作目录，只能访问工作目录内的文件。`);
      }
      try {
        const content = await fs.readFile(abs, "utf8");
        return content.trim() ? ok(content) : ok(`${file} 是空文件。`);
      } catch {
        try {
          const siblings = await fs.readdir(path.dirname(abs));
          return fail(
            `文件 "${file}" 不存在。同目录下有：${siblings.filter((f) => !f.startsWith(".")).join(", ")}`,
          );
        } catch {
          return fail(`文件 "${file}" 不存在，它所在的目录也不存在。`);
        }
      }
    },
  })
  .add({
    name: "emit_dto",
    description:
      "提交解析好的 DTO 结构，完成任务。提交后会自动做编译检查和字段核对，" +
      "有问题会把具体错误返回给你。读完文档、确认每个 interface 都齐了再调用。",
    input: dtoSchema,
    // 这一个标记就是 mini/ 和 agent.ts 的关键差别：
    // 终止语义写在工具定义里，循环不需要硬编码工具名
    terminal: true,
    run: () => ok(""), // terminal 工具的实际处理在 judge 里
  });

// ================================================================
// CLI
// ================================================================

const args = process.argv.slice(2);
const flagValue = (name: string) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const resumeFile = flagValue("--resume");
const outArg = flagValue("-o");
const styleArg = flagValue("--style");
const positional = args.filter((a, i) => {
  if (a.startsWith("-")) return false;
  const prev = args[i - 1];
  return prev !== "-o" && prev !== "--style" && prev !== "--resume";
});
const workDir = positional[0];
const docName = positional[1];

if (!workDir) {
  console.error(`
用法: npm run mini -- <工作目录> [文档] [选项]

用 mini/ 框架跑 v2/v3 场景，验证框架能替代 src/agent.ts。

选项:
  --resume <快照>   从快照恢复，接着跑
  --style <plain|i-prefix>
  -o <输出路径>

例子:
  npm run mini -- fixtures/repo src/common/api/docs/refundOrder.md
  npm run mini -- fixtures/repo --resume .sessions/s123.json
`);
  process.exit(1);
}

const fallbackStyle: NamingStyle = styleArg === "plain" ? "plain" : "i-prefix";
const root = path.resolve(workDir);
const ctx: Ctx = { root };

/** 找文档给断言层用 */
async function guessDoc(): Promise<string | undefined> {
  if (docName) return path.join(root, docName);
  const acc: string[] = [];
  await walk(root, ".", 8, acc);
  const md = acc.filter((f) => f.endsWith(".md") && !f.includes("expected"));
  return md.length === 1 ? path.join(root, md[0]!) : undefined;
}

const docPath = await guessDoc();
const docText = docPath ? await fs.readFile(docPath, "utf8") : undefined;

/**
 * 判定提交。和 agent-cli.ts 里的 review 是同一套逻辑 ——
 * 这正是重点：业务判据没变，只换了循环实现。
 */
async function judge(_name: string, input: unknown) {
  const spec = input as DtoSpec;
  const style = spec.namingStyle ?? fallbackStyle;
  const code = render(spec, style);
  const compile = verify(code, { externals: externalTypes(spec, style) });
  const errs = compile.issues.filter((i) => i.kind !== "missing-type");

  let assertReport = "";
  let assertOk = true;
  if (docText) {
    const asserted = assertSpec(docText, spec);
    const fails = asserted.violations.filter((v) => v.severity === "fail");
    assertOk = asserted.ok;
    if (fails.length > 0) {
      assertReport =
        `\n和文档核对后发现 ${fails.length} 处不一致：\n` +
        fails.map((v) => `  · ${v.where}：${v.message}`).join("\n");
    }
  }

  if (errs.length === 0 && assertOk) return { ok: true, feedback: "" };

  let feedback = "提交没有通过检查。\n";
  if (errs.length > 0) {
    feedback +=
      `\n生成的 TypeScript 编译不过，${errs.length} 个问题：\n` +
      errs.map((i) => `  · 第 ${i.line} 行：${i.message}`).join("\n");
  }
  return { ok: false, feedback: feedback + assertReport + `\n\n请对照文档核对后重新提交。` };
}

const session = resumeFile ? await Session.load(resumeFile) : new Session();
if (resumeFile) {
  console.error(
    `\x1b[90m从快照恢复 ${resumeFile}（${session.messages.length} 条消息，已跑 ${session.turns} 轮）\x1b[0m`,
  );
}

const task = docName
  ? `仓库里有一份接口文档 ${docName}，读它，照着仓库既有的写法转成 TypeScript DTO 提交。`
  : `仓库里有接口文档，找到它，读完并照着仓库既有的写法转成 TypeScript DTO 提交。`;

console.error(`\x1b[90m沙箱 ${root}\x1b[0m`);
console.error(`\x1b[90m工具 ${registry.names().join("、")}\x1b[0m\n`);

function onStep(step: Step) {
  if (step.type === "tool") {
    const mark = step.isError ? "\x1b[31m✗\x1b[0m" : "\x1b[90m→\x1b[0m";
    const size = step.isError ? step.result.slice(0, 60) : `${step.result.length} 字符`;
    console.error(`${mark} ${step.name} \x1b[90m${JSON.stringify(step.input)}\x1b[0m  ${size}`);
  } else if (step.type === "terminal") {
    console.error(
      step.ok
        ? `\x1b[32m✓\x1b[0m ${step.name} 通过检查`
        : `\x1b[33m!\x1b[0m ${step.name} 未通过，反馈给模型让它修`,
    );
  } else if (step.type === "nudge") {
    console.error(`\x1b[33m!\x1b[0m ${step.reason}`);
  } else if (step.type === "trim") {
    console.error(
      `\x1b[36m⊟\x1b[0m 上下文压缩：裁了 ${step.trimmed} 块，` +
        `~${step.before} → ~${step.after} token`,
    );
  } else if (step.type === "text") {
    console.error(`\x1b[90m  ${step.text.replace(/\s+/g, " ").slice(0, 100)}\x1b[0m`);
  }
}

const result = await run<Ctx>({
  ctx,
  registry,
  system: SYSTEM_PROMPT,
  task,
  judge,
  session,
  label: "mini",
  onStep,
  // 每轮存快照 —— 这样中断后能接着跑
  onTurn: async (s) => void (await s.save(SESSION_DIR)),
});

const REASON: Record<string, string> = {
  done: "\x1b[32m完成\x1b[0m",
  "max-turns": "\x1b[31m轮次用尽\x1b[0m",
  "max-terminal": "\x1b[31m提交次数用尽，改不对\x1b[0m",
  "no-progress": "\x1b[31m卡住了，连续重复同样的调用\x1b[0m",
  "gave-up": "\x1b[31m模型放弃，没有提交\x1b[0m",
};

console.error(
  `\n${REASON[result.stopReason] ?? result.stopReason}  ` +
    `\x1b[90m${result.turns} 轮，${result.terminalCalls} 次提交\x1b[0m`,
);
console.error(formatSummary());
console.error(`\x1b[90m快照 ${SESSION_DIR}/${result.session.id}.json\x1b[0m`);

if (!result.output) {
  console.error(`\x1b[31m没有拿到结果\x1b[0m`);
  process.exit(1);
}

const spec = result.output as DtoSpec;
const style = spec.namingStyle ?? fallbackStyle;
const code = render(spec, style);
const fields = spec.interfaces.reduce((n, i) => n + i.fields.length, 0);

if (outArg) {
  await fs.mkdir(path.dirname(outArg), { recursive: true });
  await fs.writeFile(outArg, code, "utf8");
  console.error(
    `\x1b[32m✓\x1b[0m 写入 ${outArg}（${spec.interfaces.length} 个 interface，${fields} 个字段，风格 ${style}）`,
  );
} else {
  console.log(code);
  console.error(
    `\x1b[32m✓\x1b[0m ${spec.interfaces.length} 个 interface，${fields} 个字段，风格 ${style}`,
  );
}

if (result.stopReason !== "done") process.exit(1);
