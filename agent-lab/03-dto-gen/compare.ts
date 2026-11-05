/**
 * 三个编排范式跑同一批任务，对比开销和效果。
 *
 * 跑：npm run compare                 全部 repo case
 *     npm run compare -- --runs 2     每个跑两次
 *     npm run compare -- geo          只跑匹配的
 *
 * 这个脚本的目的不是选出「最好的范式」，是拿到数据证明
 * 「这个任务不需要更复杂的编排」。阶段 3 的重点是学会判断何时【不】需要。
 *
 * 看三个数：通过率、模型调用次数、token。
 * 如果复杂范式的通过率没提升而开销翻倍，结论就很清楚了。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { render, externalTypes, type NamingStyle } from "./src/render.js";
import { verify } from "./src/verify.js";
import { assertSpec } from "./src/assert.js";
import { PATTERNS, type PatternName, type PatternResult } from "./src/patterns.js";
import { CASES, type RepoCase } from "./fixtures/cases.js";
import { formatSummary, estimateCost, clearCache } from "./src/llm.js";
import type { DtoSpec } from "./src/schema.js";

const FALLBACK: NamingStyle = "i-prefix";

const args = process.argv.slice(2);
const runsAt = args.indexOf("--runs");
const RUNS = runsAt >= 0 ? Number(args[runsAt + 1]) || 1 : 1;
const valueAt = runsAt >= 0 ? runsAt + 1 : -1;
const filter = args.find((a, i) => !a.startsWith("-") && i !== valueAt);

const repoCases = CASES.filter(
  (c): c is RepoCase => c.kind === "repo" && (!filter || c.name.includes(filter)),
);

if (repoCases.length === 0) {
  console.error(`没有匹配的 repo case`);
  process.exit(1);
}

interface Tally {
  pass: number;
  total: number;
  calls: number;
  input: number;
  output: number;
  ms: number;
  /** 命名风格判断错的次数 */
  styleBad: number;
  notes: string[];
}

function emptyTally(): Tally {
  return { pass: 0, total: 0, calls: 0, input: 0, output: 0, ms: 0, styleBad: 0, notes: [] };
}

/** 客观判据。三个范式共用同一套，保证对比公平 */
/**
 * Evaluator。四个范式共用同一套，保证对比公平。
 *
 * 这里有个踩过的坑值得记：原版漏了 namingStyle 检查。
 * 后果很隐蔽 —— Evaluator 说「通过」，agent 收工，然后 finalJudge
 * 因为风格不对判它失败。等于考完才告诉它这题也算分。
 *
 * 表现出来是 reflexion-oracle 一条教训都没提炼（它以为自己全对），
 * 却失败 2/3 次。Reflexion 的效果上限由 Evaluator 决定 ——
 * 论文这句话的具体含义就是这个：Evaluator 漏检的维度，
 * 自省再多轮也发现不了。
 */
function makeReview(doc: string, expectStyle: NamingStyle) {
  return (spec: DtoSpec) => {
    const style = spec.namingStyle ?? FALLBACK;
    const code = render(spec, style);
    const compile = verify(code, { externals: externalTypes(spec, style) });
    const errs = compile.issues.filter((i) => i.kind !== "missing-type");
    const asserted = assertSpec(doc, spec);
    const fails = asserted.violations.filter((v) => v.severity === "fail");
    // 判据必须和最终评分一致，否则 agent 是在盲考
    const styleOk = spec.namingStyle === expectStyle;

    if (errs.length === 0 && fails.length === 0 && styleOk) {
      return { ok: true, feedback: "" };
    }

    let feedback = "提交没有通过检查。\n";
    if (!styleOk) {
      feedback +=
        `\n命名风格不对：你报告的 namingStyle 是 ${spec.namingStyle ?? "(没报告)"}。` +
        `去目标目录读一个既有的 .interface.ts，看它的 interface 名有没有 I 前缀，` +
        `然后在 namingStyle 里如实报告。\n`;
    }
    if (errs.length > 0) {
      feedback +=
        `\n编译不过：\n` + errs.map((i) => `  · 第 ${i.line} 行：${i.message}`).join("\n");
    }
    if (fails.length > 0) {
      feedback += `\n和文档核对不一致：\n` + fails.map((v) => `  · ${v.where}：${v.message}`).join("\n");
    }
    return { ok: false, feedback: feedback + `\n\n请对照文档核对后重新提交完整结果。` };
  };
}

/** 最终判定：跑完之后再独立判一次，不信范式自己的说法 */
function finalJudge(doc: string, c: RepoCase, res: PatternResult) {
  if (!res.spec) return { ok: false, styleOk: false };
  const style = res.spec.namingStyle ?? FALLBACK;
  const code = render(res.spec, style);
  const compile = verify(code, { externals: externalTypes(res.spec, style) });
  const compileOk = compile.issues.every((i) => i.kind === "missing-type");
  const asserted = assertSpec(doc, res.spec);
  const styleOk = res.spec.namingStyle === c.expectStyle;
  return { ok: compileOk && asserted.ok && styleOk, styleOk };
}

const names = Object.keys(PATTERNS) as PatternName[];
const tallies = new Map<PatternName, Tally>(names.map((n) => [n, emptyTally()]));

console.log(
  `\x1b[1m${repoCases.length} 个 case × ${RUNS} 次 × ${names.length} 个范式\x1b[0m\n`,
);

const header = `${"case".padEnd(22)}${names.map((n) => n.padEnd(16)).join("")}`;
console.log(`\x1b[90m${header}\x1b[0m`);

for (const c of repoCases) {
  const root = path.resolve(c.root);
  const doc = await fs.readFile(path.join(root, c.docForAssert), "utf8");
  const review = makeReview(doc, c.expectStyle);
  const task = c.doc
    ? `仓库里有一份接口文档 ${c.doc}，读它，照着仓库既有的写法转成 TypeScript DTO 提交。`
    : `仓库里有接口文档，找到它，读完并照着仓库既有的写法转成 TypeScript DTO 提交。`;

  process.stdout.write(c.name.padEnd(22));

  for (const name of names) {
    const tally = tallies.get(name)!;
    let cellPass = 0;
    let cellCalls = 0;

    for (let i = 0; i < RUNS; i++) {
      // 每个范式跑前清缓存。
      //
      // 不清会让对比完全失效：四个范式的第一轮请求（同样的 system + tools +
      // 第一条 user 消息）哈希相同，后跑的范式直接命中前面的缓存，
      // 报出 12ms / $0 这种数字。踩过 —— reflexion-oracle 第一版
      // 看着「零成本通过」，实际是整条链路都在吃 react 的缓存。
      //
      // 缓存本身没错，它在生产上是对的；错的是在对比实验里留着它。
      clearCache();
      const started = Date.now();
      let res: PatternResult;
      try {
        res = await PATTERNS[name]({ ctx: { root }, task, review });
      } catch (e) {
        res = { calls: 0, usage: { input: 0, output: 0 }, notes: [`异常：${String(e)}`] };
      }
      const ms = Date.now() - started;
      const { ok, styleOk } = finalJudge(doc, c, res);

      tally.total++;
      tally.calls += res.calls;
      tally.input += res.usage.input;
      tally.output += res.usage.output;
      tally.ms += ms;
      if (ok) {
        tally.pass++;
        cellPass++;
      }
      if (!styleOk) tally.styleBad++;
      cellCalls += res.calls;
      // 范式特有的中间产物留着，最后展示 —— 这是看它「多做了什么」的窗口
      for (const note of res.notes) tally.notes.push(`[${c.name}] ${note}`);
    }

    const mark = cellPass === RUNS ? "\x1b[32m✓\x1b[0m" : cellPass === 0 ? "\x1b[31m✗\x1b[0m" : "\x1b[33m~\x1b[0m";
    const cell = `${mark} ${cellPass}/${RUNS} ${Math.round(cellCalls / RUNS)}调用`;
    process.stdout.write(cell.padEnd(16 + 9)); // +9 补偿 ANSI 转义符宽度
  }
  console.log();
}

// ---- 汇总 ----

console.log(`\n\x1b[1m对比\x1b[0m`);
console.log(
  `\x1b[90m${"范式".padEnd(16)}${"通过率".padEnd(10)}${"调用/次".padEnd(10)}` +
    `${"token".padEnd(16)}${"成本".padEnd(10)}${"耗时/次".padEnd(10)}风格错\x1b[0m`,
);

for (const name of names) {
  const t = tallies.get(name)!;
  const rate = ((t.pass / t.total) * 100).toFixed(0);
  const avgCalls = (t.calls / t.total).toFixed(1);
  const avgMs = Math.round(t.ms / t.total);
  const tok = `${t.input}/${t.output}`;
  // 成本比 token 更有说服力 —— 输出 token 贵 5 倍，光看总量会低估
  const cost = `$${estimateCost("claude-sonnet-5", t.input, t.output).toFixed(4)}`;
  console.log(
    `${name.padEnd(16)}${`${rate}%`.padEnd(10)}${avgCalls.padEnd(10)}` +
      `${tok.padEnd(16)}${cost.padEnd(10)}${`${avgMs}ms`.padEnd(10)}${t.styleBad}`,
  );
}

// 基线是 react，看其他范式相对它多花了多少
const base = tallies.get("react")!;
console.log(`\n\x1b[1m相对 ReAct\x1b[0m`);
for (const name of names) {
  if (name === "react") continue;
  const t = tallies.get(name)!;
  const callRatio = (t.calls / base.calls).toFixed(2);
  const tokRatio = ((t.input + t.output) / (base.input + base.output)).toFixed(2);
  const rateDelta = ((t.pass / t.total - base.pass / base.total) * 100).toFixed(0);
  const sign = Number(rateDelta) > 0 ? "+" : "";
  console.log(
    `${name.padEnd(16)}调用 ${callRatio}×  token ${tokRatio}×  通过率 ${sign}${rateDelta} 个百分点`,
  );
}

// 范式的中间产物 —— 计划长什么样、自省说了什么
const allNotes = names.flatMap((n) => tallies.get(n)!.notes);
if (allNotes.length > 0) {
  console.log(`\n\x1b[1m中间产物\x1b[0m \x1b[90m（复杂范式多做的那部分）\x1b[0m`);
  for (const note of allNotes.slice(0, 24)) console.log(`  \x1b[90m${note}\x1b[0m`);
}

// 按 label 归因：能看到 plan 阶段、critique 阶段各自花了多少
console.log(`\n${formatSummary()}`);
