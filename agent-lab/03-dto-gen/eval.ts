/**
 * 评估台 —— 跑一批 case，输出通过率。
 *
 * 跑：npm run eval                    全部 fixture
 *     npm run eval -- --runs 3        每个 case 跑 3 次，看稳不稳
 *     npm run eval -- searchHotel     只跑名字匹配的
 *
 * 这是阶段 2 的毕业标准：改一版 prompt，看通过率这个数字动。
 *
 * 为什么非要它 —— 前面几轮改 prompt 全是在单个 case 上凭感觉，
 * 「好像好了点」是没法验证的判断。BFF 那套「写完跑 UT 就知道对不对」
 * 在这里失效了：同样的输入，模型可能给出不一样的输出。
 * 所以要的不是「对/错」，是「20 个 case 里过了几个」。
 *
 * --runs 那个参数是这个阶段最该体会的东西：
 * 同一个 case 跑三次结果可能不同。跑一次全绿不代表稳定，
 * 得看多次运行的一致性。这是非确定性系统的常态，不是 bug。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { generate } from "./src/generate.js";
import { render, externalTypes, type NamingStyle } from "./src/render.js";
import { verify } from "./src/verify.js";
import { assertSpec, type Violation } from "./src/assert.js";
import { runAgent, type EmitReview } from "./src/agent.js";
import { CASES, type EvalCase, type RepoCase } from "./fixtures/cases.js";
import { formatSummary } from "./src/llm.js";
import type { DtoSpec } from "./src/schema.js";

/** doc case 用的兜底风格。repo case 的风格由模型自己判断 */
const STYLE: NamingStyle = "i-prefix";

const args = process.argv.slice(2);
const runsAt = args.indexOf("--runs");
const RUNS = runsAt >= 0 ? Number(args[runsAt + 1]) || 1 : 1;
// 排除 --runs 的值之后，第一个裸参数当过滤词。
// 这里有个坑：runsAt 为 -1（没传 --runs）时 runsAt+1 是 0，
// 用 i !== runsAt+1 会把 args[0] 也就是过滤词本身排掉。所以要先判有没有传。
const valueAt = runsAt >= 0 ? runsAt + 1 : -1;
const filter = args.find((a, i) => !a.startsWith("-") && i !== valueAt);

interface CaseRun {
  ok: boolean;
  /** 编译问题数（不含外部类型） */
  compileErrors: number;
  /** 断言硬伤 */
  fails: Violation[];
  warns: Violation[];
  /** 模型重试次数 */
  retries: number;
  ms: number;
  error?: string;
  /** repo case 独有 */
  turns?: number;
  stopReason?: string;
  /** 命名风格判断对不对 —— v3 的核心断言 */
  styleOk?: boolean;
  styleGot?: string;
  tokens?: { input: number; output: number };
}

interface CaseResult {
  name: string;
  runs: CaseRun[];
}

/** 把 spec 跑一遍编译 + 断言，两类 case 共用 */
function judge(doc: string, spec: DtoSpec, style: NamingStyle) {
  const code = render(spec, style);
  const compile = verify(code, { externals: externalTypes(spec, style) });
  const compileErrors = compile.issues.filter((i) => i.kind !== "missing-type").length;
  const asserted = assertSpec(doc, spec);
  return {
    compileOk: compile.ok,
    compileErrors,
    assertOk: asserted.ok,
    fails: asserted.violations.filter((v) => v.severity === "fail"),
    warns: asserted.violations.filter((v) => v.severity === "warn"),
  };
}

/** 异常 → 一行摘要。堆栈对看通过率没用，留第一行够了 */
function firstLine(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n")[0] ?? msg;
}

const blank = (ms: number, error: string): CaseRun => ({
  ok: false,
  compileErrors: 0,
  fails: [],
  warns: [],
  retries: 0,
  ms,
  error,
});

/** v1 单轮 */
async function runDocCase(docPath: string): Promise<CaseRun> {
  const started = Date.now();
  try {
    const doc = await fs.readFile(docPath, "utf8");
    const { spec, attempts } = await generate(doc);
    const j = judge(doc, spec, STYLE);
    return {
      ok: j.compileOk && j.assertOk,
      compileErrors: j.compileErrors,
      fails: j.fails,
      warns: j.warns,
      retries: attempts - 1,
      ms: Date.now() - started,
    };
  } catch (e) {
    return blank(Date.now() - started, firstLine(e));
  }
}

/**
 * v3 多轮。
 *
 * 注意这里的 review 回调比 agent-cli 里的简化了 —— 只回编译结果，不回断言结果。
 * 理由：eval 要测的是「模型自己能做到什么」，如果把断言失败反馈给它让它改，
 * 测出来的是「反馈循环有多强」，而不是「模型有多准」。
 * 两者都值得测，但不该混在一个数字里。
 */
async function runRepoCase(c: RepoCase): Promise<CaseRun> {
  const started = Date.now();
  const root = path.resolve(c.root);

  try {
    const doc = await fs.readFile(path.join(root, c.docForAssert), "utf8");

    const review = (spec: DtoSpec): EmitReview => {
      const style = spec.namingStyle ?? STYLE;
      const code = render(spec, style);
      const compile = verify(code, { externals: externalTypes(spec, style) });
      const errs = compile.issues.filter((i) => i.kind !== "missing-type");
      // 风格是最终评分的一部分，所以必须告知 —— 否则 agent 在盲考：
      // review 说通过、它收工，然后因为没报告风格被判失败。
      // 踩过：hard case 稳定失败在这里，看着像模型不行，实际是我没告诉它这题算分。
      const styleMissing = spec.namingStyle === undefined;

      if (errs.length === 0 && !styleMissing) return { ok: true, feedback: "" };

      let feedback = "";
      if (styleMissing) {
        feedback +=
          `你没有报告 namingStyle。去目标目录读一个既有的 .interface.ts，` +
          `看它的 interface 名有没有 I 前缀，然后在 namingStyle 里如实填写。\n`;
      }
      if (errs.length > 0) {
        feedback +=
          `\n生成的 TypeScript 编译不过，${errs.length} 个问题：\n` +
          errs.map((i) => `  · 第 ${i.line} 行：${i.message}`).join("\n");
      }
      return { ok: false, feedback: feedback + `\n\n请对照文档核对后重新提交完整结果。` };
    };

    const task = c.doc
      ? `仓库里有一份接口文档 ${c.doc}，读它，照着仓库既有的写法转成 TypeScript DTO 提交。`
      : `仓库里有接口文档，找到它，读完并照着仓库既有的写法转成 TypeScript DTO 提交。`;

    const res = await runAgent({ ctx: { root }, task, review });

    if (!res.spec) {
      return {
        ...blank(Date.now() - started, `没有提交结果（${res.stopReason}）`),
        turns: res.turns,
        stopReason: res.stopReason,
        tokens: res.usage,
      };
    }

    const styleGot = res.spec.namingStyle;
    const styleOk = styleGot === c.expectStyle;
    const j = judge(doc, res.spec, styleGot ?? STYLE);

    return {
      // 风格判断错了也算失败 —— 产物能编译但和仓库对不上，人还得手改
      ok: j.compileOk && j.assertOk && styleOk && res.stopReason === "done",
      compileErrors: j.compileErrors,
      fails: j.fails,
      warns: j.warns,
      retries: 0,
      ms: Date.now() - started,
      turns: res.turns,
      stopReason: res.stopReason,
      styleOk,
      styleGot: styleGot ?? "(没报告)",
      tokens: res.usage,
    };
  } catch (e) {
    return blank(Date.now() - started, firstLine(e));
  }
}

function runOne(c: EvalCase): Promise<CaseRun> {
  return c.kind === "doc" ? runDocCase(c.doc) : runRepoCase(c);
}

const selected = CASES.filter((c) => !filter || c.name.includes(filter));

if (selected.length === 0) {
  console.error(`没有匹配 "${filter}" 的 case。可用的：${CASES.map((c) => c.name).join(", ")}`);
  process.exit(1);
}

const docCount = selected.filter((c) => c.kind === "doc").length;
const repoCount = selected.length - docCount;
console.log(
  `\x1b[1m${selected.length} 个 case × ${RUNS} 次\x1b[0m` +
    `  \x1b[90m${docCount} 个单轮 / ${repoCount} 个多轮\x1b[0m\n`,
);

const results: CaseResult[] = [];

for (const c of selected) {
  const runs: CaseRun[] = [];
  process.stdout.write(`${c.name.padEnd(22)}`);

  for (let i = 0; i < RUNS; i++) {
    const run = await runOne(c);
    runs.push(run);
    process.stdout.write(run.ok ? "\x1b[32m·\x1b[0m" : "\x1b[31m×\x1b[0m");
  }

  const passed = runs.filter((r) => r.ok).length;
  const avgMs = Math.round(runs.reduce((n, r) => n + r.ms, 0) / runs.length);
  const tag =
    passed === RUNS
      ? `\x1b[32m${passed}/${RUNS}\x1b[0m`
      : passed === 0
        ? `\x1b[31m${passed}/${RUNS}\x1b[0m`
        : `\x1b[33m${passed}/${RUNS}\x1b[0m`; // 部分通过 = 不稳定，最值得注意

  // 多轮 case 额外报轮次和风格判断，这两个是 v3 的观察点
  const extra =
    c.kind === "repo"
      ? `  \x1b[90m${Math.round(runs.reduce((n, r) => n + (r.turns ?? 0), 0) / runs.length)} 轮` +
        `  风格 ${runs[0]!.styleGot ?? "?"}${runs.every((r) => r.styleOk) ? "" : " \x1b[31m✗\x1b[0m"}\x1b[0m`
      : "";

  console.log(`  ${tag}  \x1b[90m${avgMs}ms\x1b[0m${extra}`);
  results.push({ name: c.name, runs });
}

// ---- 汇总 ----

const allRuns = results.flatMap((r) => r.runs);
const passedRuns = allRuns.filter((r) => r.ok).length;
const rate = ((passedRuns / allRuns.length) * 100).toFixed(1);

console.log(`\n\x1b[1m通过率 ${rate}%\x1b[0m  (${passedRuns}/${allRuns.length} 次运行)`);

// 稳定性：同一个 case 多次运行结果不一致的，单独点出来
const flaky = results.filter((r) => {
  const p = r.runs.filter((x) => x.ok).length;
  return p > 0 && p < r.runs.length;
});
if (flaky.length > 0) {
  console.log(
    `\x1b[33m不稳定 ${flaky.length} 个\x1b[0m：${flaky.map((f) => f.name).join(", ")}` +
      `  \x1b[90m同样输入结果不同，比稳定失败更难查\x1b[0m`,
  );
}

const retried = allRuns.filter((r) => r.retries > 0).length;
if (retried > 0) {
  console.log(`\x1b[90mschema 校验触发重试 ${retried} 次运行\x1b[0m`);
}

// 命名风格判断错的单独点出来 —— v3 的核心能力，混在通过率里看不清
const styleRuns = allRuns.filter((r) => r.styleOk !== undefined);
if (styleRuns.length > 0) {
  const styleBad = styleRuns.filter((r) => !r.styleOk);
  console.log(
    styleBad.length === 0
      ? `\x1b[90m命名风格判断 ${styleRuns.length}/${styleRuns.length} 正确\x1b[0m`
      : `\x1b[31m命名风格判断错 ${styleBad.length}/${styleRuns.length}\x1b[0m` +
          `  \x1b[90m产物能编译但和仓库风格对不上，人还得手改\x1b[0m`,
  );
}

const tokenRuns = allRuns.filter((r) => r.tokens);
if (tokenRuns.length > 0) {
  const avgTurns = (tokenRuns.reduce((n, r) => n + (r.turns ?? 0), 0) / tokenRuns.length).toFixed(1);
  console.log(`\x1b[90m多轮 case 平均 ${avgTurns} 轮\x1b[0m`);
}

// 整场 eval 的成本。跑一次 eval 花多少钱要看得见，
// 否则「多跑几次看稳定性」这个建议就是空话
console.log(`\n${formatSummary()}`);

// 错误按 rule 归类 —— 这是改 prompt 的依据，比看单条报错有用
const byRule = new Map<string, number>();
for (const run of allRuns) {
  for (const v of run.fails) byRule.set(v.rule, (byRule.get(v.rule) ?? 0) + 1);
}
if (byRule.size > 0) {
  console.log(`\n\x1b[1m失败归类\x1b[0m（改 prompt 先看占比最高的）`);
  for (const [rule, n] of [...byRule].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${String(n).padStart(3)}  ${rule}`);
  }
}

// 详情：只打失败的
const failedCases = results.filter((r) => r.runs.some((x) => !x.ok));
if (failedCases.length > 0) {
  console.log(`\n\x1b[1m失败详情\x1b[0m`);
  for (const c of failedCases) {
    console.log(`\n\x1b[31m${c.name}\x1b[0m`);
    const seen = new Set<string>();
    for (const run of c.runs) {
      if (run.ok) continue;
      if (run.error) {
        console.log(`  \x1b[31m!\x1b[0m ${run.error}`);
        continue;
      }
      if (run.compileErrors > 0) {
        console.log(`  编译错误 ${run.compileErrors} 个`);
      }
      if (run.styleOk === false) {
        console.log(`  \x1b[31m✗\x1b[0m 命名风格判断错：报告 ${run.styleGot}`);
      }
      if (run.stopReason && run.stopReason !== "done") {
        console.log(`  \x1b[31m✗\x1b[0m 循环异常退出：${run.stopReason}（${run.turns} 轮）`);
      }
      // 多次运行的相同问题去重，不然 --runs 3 会刷三遍一样的
      for (const v of run.fails) {
        const key = `${v.rule}:${v.where}`;
        if (seen.has(key)) continue;
        seen.add(key);
        console.log(`  \x1b[31m✗\x1b[0m ${v.where}  ${v.message}`);
      }
    }
  }
}

const warnCount = allRuns.reduce((n, r) => n + r.warns.length, 0);
if (warnCount > 0) {
  console.log(`\n\x1b[90m另有 ${warnCount} 个警告（注释类），不计入通过率\x1b[0m`);
}

process.exit(passedRuns === allRuns.length ? 0 : 1);
