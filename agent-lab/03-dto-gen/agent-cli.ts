/**
 * v2 的入口 —— 多轮自主。
 *
 * 跑：npm run agent -- fixtures                      让它自己找文档
 *     npm run agent -- fixtures queryCityInfo.md     指定文档
 *     npm run agent -- fixtures --style plain -o out/x.ts
 *
 * 和 v1（npm start）的区别：
 *   v1  我读文件、把内容塞给模型、它一次性返回结构
 *   v2  我只告诉它工作目录，它自己 list_files、read_file、emit_dto，
 *       提交不合格还会收到反馈自己修
 *
 * 两个入口都留着，因为 v1 仍然是跑 eval 的那条路 —— 它更快更省，
 * 单文档场景没必要多轮。v2 的价值在文档位置不确定、需要参考现有文件的场景。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { render, externalTypes, type NamingStyle } from "./src/render.js";
import { verify, formatIssues } from "./src/verify.js";
import { assertSpec, formatViolations } from "./src/assert.js";
import { runAgent, type EmitReview } from "./src/agent.js";
import { formatSummary } from "./src/llm.js";
import type { DtoSpec } from "./src/schema.js";

const args = process.argv.slice(2);
const positional = args.filter((a, i) => {
  if (a.startsWith("-")) return false;
  const prev = args[i - 1];
  return prev !== "-o" && prev !== "--style";
});
const workDir = positional[0];
const docName = positional[1];
const styleArg = args.includes("--style") ? args[args.indexOf("--style") + 1] : undefined;
const outArg = args.includes("-o") ? args[args.indexOf("-o") + 1] : undefined;

if (!workDir) {
  console.error(`
用法: npm run agent -- <工作目录> [文档文件名] [选项]

工作目录是 agent 的沙箱，它只能读这个目录里的文件。
不指定文档文件名时，它自己 list_files 找。

选项:
  --style <plain|i-prefix>   命名风格，默认 i-prefix
  -o <输出路径>               写入文件，不给就打印

例子:
  npm run agent -- fixtures
  npm run agent -- fixtures queryCityInfo.md -o out/city.ts
`);
  process.exit(1);
}

/**
 * 命名风格有两个来源，优先级是：模型观察到的 > 命令行指定的。
 *
 * 这是 v3 的核心变化。v2 是我用 --style 告诉它怎么写，
 * v3 是它自己看目标目录的邻居文件决定 —— 因为同一个仓库里
 * 不同目录的约定可能不一样，写死在参数里必然有一边是错的。
 *
 * --style 退化成兜底：目标目录没有参考文件时才用。
 */
const fallbackStyle: NamingStyle = styleArg === "plain" ? "plain" : "i-prefix";
const root = path.resolve(workDir);

const task = docName
  ? `仓库里有一份接口文档 ${docName}，读它，照着仓库既有的写法转成 TypeScript DTO 提交。`
  : `仓库里有接口文档，找到它，读完并照着仓库既有的写法转成 TypeScript DTO 提交。` +
    `如果有多份文档，选一份最主要的（通常是文件名不带 expected / example 的那份）。`;

console.error(`\x1b[90m沙箱 ${root}\x1b[0m`);
console.error(`\x1b[90m任务 ${task}\x1b[0m\n`);

/**
 * 校验一次提交。这是 v2 的关键接口 ——
 * 把 verify + assert 的结果翻译成给模型的反馈。
 *
 * 措辞上有意识地写成「哪里错了 + 对照文档怎么改」，
 * 而不是罗列报错。这跟阶段 1 MCP 工具的错误措辞是同一件事。
 */
/** 这次提交实际用的风格：模型报告的优先，没报告就用兜底 */
function styleOf(spec: DtoSpec): NamingStyle {
  return spec.namingStyle ?? fallbackStyle;
}

async function review(spec: DtoSpec): Promise<EmitReview> {
  const style = styleOf(spec);
  const code = render(spec, style);
  const compile = verify(code, { externals: externalTypes(spec, style) });
  const compileErrors = compile.issues.filter((i) => i.kind !== "missing-type");

  // 断言需要原始文档。agent 可能读了任意文件，所以这里按它提交的
  // interface 名去找对应文档 —— 找不到就只做编译检查
  let assertReport = "";
  let assertOk = true;
  const docFile = await guessDoc();
  if (docFile) {
    const doc = await fs.readFile(docFile, "utf8");
    const asserted = assertSpec(doc, spec);
    const fails = asserted.violations.filter((v) => v.severity === "fail");
    assertOk = asserted.ok;
    if (fails.length > 0) {
      assertReport =
        `\n和文档核对后发现 ${fails.length} 处不一致：\n` +
        fails.map((v) => `  · ${v.where}：${v.message}`).join("\n");
    }
  }

  if (compileErrors.length === 0 && assertOk) {
    return { ok: true, feedback: "" };
  }

  let feedback = "提交没有通过检查。\n";
  if (compileErrors.length > 0) {
    feedback +=
      `\n生成的 TypeScript 编译不过，${compileErrors.length} 个问题：\n` +
      compileErrors.map((i) => `  · 第 ${i.line} 行：${i.message}`).join("\n");
  }
  feedback += assertReport;
  feedback += `\n\n请对照文档核对后重新提交完整结果。`;
  return { ok: false, feedback };
}

/** 找出工作目录里的文档，给断言层用 */
async function guessDoc(): Promise<string | undefined> {
  if (docName) return path.join(root, docName);
  const entries = await fs.readdir(root);
  const md = entries.filter((f) => f.endsWith(".md") && !f.includes("expected"));
  return md.length === 1 ? path.join(root, md[0]!) : undefined;
}

const result = await runAgent({
  ctx: { root },
  task,
  review,
  onStep(step) {
    if (step.type === "tool") {
      const arg = JSON.stringify(step.input);
      const mark = step.isError ? "\x1b[31m✗\x1b[0m" : "\x1b[90m→\x1b[0m";
      const size = step.isError ? step.result : `${step.result.length} 字符`;
      console.error(`${mark} ${step.name} \x1b[90m${arg}\x1b[0m  ${size}`);
    } else if (step.type === "emit") {
      console.error(
        step.ok
          ? `\x1b[32m✓\x1b[0m emit_dto 通过检查`
          : `\x1b[33m!\x1b[0m emit_dto 未通过，反馈给模型让它修`,
      );
    } else if (step.type === "nudge") {
      console.error(`\x1b[33m!\x1b[0m ${step.reason}，推它一次`);
    } else if (step.type === "text") {
      const oneLine = step.text.replace(/\s+/g, " ").slice(0, 100);
      console.error(`\x1b[90m  ${oneLine}\x1b[0m`);
    }
  },
});

// ---- 结果 ----

const REASON_TEXT: Record<string, string> = {
  done: "\x1b[32m完成\x1b[0m",
  "max-turns": "\x1b[31m轮次用尽\x1b[0m",
  "max-emits": "\x1b[31m提交次数用尽，改不对\x1b[0m",
  "no-progress": "\x1b[31m卡住了，连续重复同样的调用\x1b[0m",
  "gave-up": "\x1b[31m模型放弃，没有提交\x1b[0m",
};

console.error(
  `\n${REASON_TEXT[result.stopReason] ?? result.stopReason}  ` +
    `\x1b[90m${result.turns} 轮，${result.emits} 次提交\x1b[0m`,
);
console.error(formatSummary());

if (!result.spec) {
  console.error(`\x1b[31m没有拿到结果\x1b[0m`);
  process.exit(1);
}

const finalStyle = styleOf(result.spec);
const code = render(result.spec, finalStyle);
const count = result.spec.interfaces.length;
const fields = result.spec.interfaces.reduce((n, i) => n + i.fields.length, 0);

console.error(
  result.spec.namingStyle
    ? `\x1b[90m命名风格 ${finalStyle}（模型从仓库里观察到的）\x1b[0m`
    : `\x1b[90m命名风格 ${finalStyle}（模型没报告，用的兜底值）\x1b[0m`,
);

if (outArg) {
  await fs.mkdir(path.dirname(outArg), { recursive: true });
  await fs.writeFile(outArg, code, "utf8");
  console.error(`\x1b[32m✓\x1b[0m 写入 ${outArg}（${count} 个 interface，${fields} 个字段）`);
} else {
  console.log(code);
  console.error(`\x1b[32m✓\x1b[0m ${count} 个 interface，${fields} 个字段`);
}

// 停止原因不是 done 时，产物可能是不合格的那一版 —— 退出码要反映出来
if (result.stopReason !== "done") process.exit(1);
