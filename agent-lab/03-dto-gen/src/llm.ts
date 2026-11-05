/**
 * v6 —— 所有模型调用的唯一入口。
 *
 * 之前 generate.ts / agent.ts / patterns.ts 各自 new Anthropic()，
 * 三份配置、三套用量统计、没有一处能看到全局。这是典型的「能跑但没法运营」：
 * 出问题不知道哪一步慢、花了多少钱、重试了几次。
 *
 * 这一层把五件事收到一处：
 *   1. trace      —— 每次调用记下来，可以事后看整条链路
 *   2. 成本归因   —— token 按模型分档计价，知道钱花在哪
 *   3. 重试       —— 429 / 5xx 指数退避，这类错误必然会遇到
 *   4. 限流       —— 并发闸门，别把上游打挂
 *   5. 缓存       —— 同样的请求不重复付费
 *
 * 顺序是有讲究的：限流在最外，缓存在限流内（命中缓存不占并发额度），
 * 重试在最内（重试不该重新排队）。
 *
 * 一个提醒：这些都不是「以后再说」的东西。上一步 compare 跑一次烧了十几万
 * token，我是靠手工加总才知道的 —— 看不见的成本就是控制不住的成本。
 */
import Anthropic from "@anthropic-ai/sdk";
import { createHash } from "node:crypto";

export const DEFAULT_MODEL = "claude-sonnet-5";

/**
 * 每百万 token 的价格（美元）。
 *
 * 这份表是【估算用】的，不保证和账单一致 —— 写死价格的代码迟早过期。
 * 它的作用是让相对成本可见：哪一步贵、换个模型能省多少。
 * 真要对账看账单，不要信这里。
 */
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-5": { input: 3, output: 15 },
  "claude-haiku-4": { input: 0.8, output: 4 },
  default: { input: 3, output: 15 },
};

export function estimateCost(model: string, input: number, output: number): number {
  const p = PRICING[model] ?? PRICING.default!;
  return (input * p.input + output * p.output) / 1_000_000;
}

// ================================================================
// trace
// ================================================================

export interface TraceEntry {
  seq: number;
  /** 调用方标签，比如 "agent"、"generate"、"reflexion:critique" */
  label: string;
  model: string;
  input: number;
  output: number;
  cost: number;
  ms: number;
  /** 这次调用重试了几次 */
  retries: number;
  cached: boolean;
  stopReason: string | null;
  /** 模型请求调用的工具名，看它在干什么 */
  tools: string[];
  error?: string;
}

const trace: TraceEntry[] = [];
let seq = 0;

export function getTrace(): readonly TraceEntry[] {
  return trace;
}

export function resetTrace(): void {
  trace.length = 0;
  seq = 0;
}

export interface TraceSummary {
  calls: number;
  input: number;
  output: number;
  cost: number;
  ms: number;
  retries: number;
  cacheHits: number;
  errors: number;
  /** 按 label 分组，用来回答「钱花在哪一步」 */
  byLabel: { label: string; calls: number; cost: number; input: number; output: number }[];
}

export function summarize(entries: readonly TraceEntry[] = trace): TraceSummary {
  const byLabel = new Map<string, { calls: number; cost: number; input: number; output: number }>();
  for (const e of entries) {
    const g = byLabel.get(e.label) ?? { calls: 0, cost: 0, input: 0, output: 0 };
    g.calls++;
    g.cost += e.cost;
    g.input += e.input;
    g.output += e.output;
    byLabel.set(e.label, g);
  }
  return {
    calls: entries.length,
    input: entries.reduce((n, e) => n + e.input, 0),
    output: entries.reduce((n, e) => n + e.output, 0),
    cost: entries.reduce((n, e) => n + e.cost, 0),
    ms: entries.reduce((n, e) => n + e.ms, 0),
    retries: entries.reduce((n, e) => n + e.retries, 0),
    cacheHits: entries.filter((e) => e.cached).length,
    errors: entries.filter((e) => e.error).length,
    byLabel: [...byLabel]
      .map(([label, g]) => ({ label, ...g }))
      .sort((a, b) => b.cost - a.cost),
  };
}

// ================================================================
// 成本闸
// ================================================================

/** 预算超了就抛，别让一个跑飞的循环把钱烧光 */
export class BudgetExceededError extends Error {}

let budgetUsd = Number(process.env.LLM_BUDGET_USD ?? 0) || Infinity;

export function setBudget(usd: number): void {
  budgetUsd = usd;
}

/**
 * 预算闸。
 *
 * 注意它是【事后】生效的：检查的是已花费额，所以第一次调用永远放行，
 * 超支是在下一次调用时才被拦住。想做成事前拦截就得预估本次开销，
 * 而 output token 在调用前是不可知的 —— 预估不准反而会误杀。
 *
 * 结论：这道闸防的是「循环跑飞持续烧钱」，不防「单次调用超支」。
 * 单次的上限靠 max_tokens 控制，那是另一回事。
 */
function checkBudget(): void {
  const spent = trace.reduce((n, e) => n + e.cost, 0);
  if (spent >= budgetUsd) {
    throw new BudgetExceededError(
      `累计花费 $${spent.toFixed(4)} 已达预算上限 $${budgetUsd.toFixed(4)}，停止调用。` +
        `这是累计值检查，所以实际花费会略微超出上限。`,
    );
  }
}

// ================================================================
// 限流
// ================================================================
//
// 简单的并发闸门。agent 循环本身是串行的，但 eval / compare 会并发跑多个 case，
// 没有闸门就会一次打出十几个请求，触发 429 然后全体重试 —— 反而更慢。
// ================================================================

const maxConcurrent = Number(process.env.LLM_MAX_CONCURRENT ?? 3) || 3;
let active = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<void> {
  if (active < maxConcurrent) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiting.push(resolve));
  active++;
}

function release(): void {
  active--;
  waiting.shift()?.();
}

// ================================================================
// 缓存
// ================================================================
//
// 进程内缓存，只在一次 eval 里有意义（同一个 case 跑多次、或多个范式跑同一任务）。
// 生产上该换成外部存储，但接口是一样的。
//
// 注意缓存键包含了 system + tools + messages 的完整哈希 ——
// 少任何一项都会导致「换了 prompt 但拿到旧结果」，那种 bug 极难查。
// ================================================================

const cache = new Map<string, Anthropic.Message>();
const cacheEnabled = process.env.LLM_CACHE !== "0";

function cacheKey(params: Anthropic.MessageCreateParamsNonStreaming): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        model: params.model,
        system: params.system,
        tools: params.tools,
        tool_choice: params.tool_choice,
        messages: params.messages,
        max_tokens: params.max_tokens,
      }),
    )
    .digest("hex");
}

export function clearCache(): void {
  cache.clear();
}

// ================================================================
// 重试
// ================================================================

const MAX_RETRIES = 3;

/**
 * 哪些错误值得重试。
 *
 * 这份判断是读 SDK 源码（client.js 的 shouldRetry）之后改的，我原来漏了三样：
 *
 *   x-should-retry 头  —— 服务端明确说要不要重试时，听它的。
 *                          这是最高优先级，比任何状态码判断都准。
 *   408 请求超时       —— 我只判了 429 和 5xx，漏了这个
 *   409 锁超时         —— 同上。冲突类错误重试是有意义的
 *
 * 顺序有讲究：先看服务端的显式指示，再退回到状态码猜测。
 */
function retriable(e: unknown): boolean {
  const headers = (e as { headers?: Headers | Record<string, string> })?.headers;
  const hint =
    headers instanceof Headers
      ? headers.get("x-should-retry")
      : (headers as Record<string, string> | undefined)?.["x-should-retry"];
  if (hint === "true") return true;
  if (hint === "false") return false;

  const status = (e as { status?: number })?.status;
  if (status === 408 || status === 409 || status === 429) return true;
  if (status !== undefined && status >= 500) return true;

  // 网络层抖动
  const code = (e as { code?: string })?.code;
  return code === "ECONNRESET" || code === "ETIMEDOUT" || code === "EPIPE";
}

/** 从响应头取服务端建议的等待时间。服务端说了就别自己猜 */
function retryAfterMs(e: unknown): number | undefined {
  const headers = (e as { headers?: Headers | Record<string, string> })?.headers;
  const get = (k: string) =>
    headers instanceof Headers
      ? headers.get(k)
      : (headers as Record<string, string> | undefined)?.[k];

  const ms = get("retry-after-ms");
  if (ms) {
    const n = parseFloat(ms);
    if (!Number.isNaN(n)) return n;
  }
  const secs = get("retry-after");
  if (secs) {
    const n = parseFloat(secs);
    if (!Number.isNaN(n)) return n * 1000;
  }
  return undefined;
}

/**
 * 指数退避 + 抖动。
 *
 * 参数照 SDK 对齐了：起始 0.5s（我原来是 1s，偏保守）、上限 8s。
 * 抖动改成「减去最多 25%」而不是「加上最多 300ms」—— 后者在并发量大时
 * 几乎起不到分散作用，300ms 的窗口太窄。
 */
function backoffMs(attempt: number): number {
  const sleepSeconds = Math.min(0.5 * 2 ** (attempt - 1), 8);
  const jitter = 1 - Math.random() * 0.25;
  return sleepSeconds * jitter * 1000;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ================================================================
// 入口
// ================================================================

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
  authToken: process.env.ANTHROPIC_AUTH_TOKEN,
  // SDK 自带重试关掉 —— 我们自己做，否则两层重试叠加，
  // 实际请求次数变成乘积，日志里也看不出来到底试了几次
  maxRetries: 0,
  timeout: 120_000,
});

export interface CallOptions {
  /** trace 里的分组标签。想知道钱花在哪就靠它 */
  label: string;
}

/**
 * 唯一的模型调用入口。
 *
 * 包装顺序（外 → 内）：预算检查 → 缓存 → 限流 → 重试。
 * 缓存在限流外面：命中缓存不该占并发额度，也不该等锁。
 * 重试在最里面：重试不重新排队，否则退避时间白等。
 */
export async function callModel(
  params: Anthropic.MessageCreateParamsNonStreaming,
  options: CallOptions,
): Promise<Anthropic.Message> {
  checkBudget();

  const key = cacheEnabled ? cacheKey(params) : "";
  if (cacheEnabled) {
    const hit = cache.get(key);
    if (hit) {
      trace.push({
        seq: ++seq,
        label: options.label,
        model: params.model,
        // 缓存命中不计费 —— 这是缓存的意义，也要在 trace 里如实反映
        input: 0,
        output: 0,
        cost: 0,
        ms: 0,
        retries: 0,
        cached: true,
        stopReason: hit.stop_reason,
        tools: hit.content.filter((b) => b.type === "tool_use").map((b) => b.name),
      });
      return hit;
    }
  }

  await acquire();
  const started = Date.now();
  let retries = 0;

  try {
    for (let attempt = 1; ; attempt++) {
      try {
        const res = await client.messages.create(params);
        const input = res.usage.input_tokens;
        const output = res.usage.output_tokens;

        trace.push({
          seq: ++seq,
          label: options.label,
          model: params.model,
          input,
          output,
          cost: estimateCost(params.model, input, output),
          ms: Date.now() - started,
          retries,
          cached: false,
          stopReason: res.stop_reason,
          tools: res.content.filter((b) => b.type === "tool_use").map((b) => b.name),
        });

        if (cacheEnabled) cache.set(key, res);
        return res;
      } catch (e) {
        if (attempt > MAX_RETRIES || !retriable(e)) {
          trace.push({
            seq: ++seq,
            label: options.label,
            model: params.model,
            input: 0,
            output: 0,
            cost: 0,
            ms: Date.now() - started,
            retries,
            cached: false,
            stopReason: null,
            tools: [],
            error: e instanceof Error ? e.message.slice(0, 200) : String(e),
          });
          throw e;
        }
        retries++;
        // 服务端给了 retry-after 就听它的，没给才自己算退避
        await sleep(retryAfterMs(e) ?? backoffMs(attempt));
      }
    }
  } finally {
    release();
  }
}

/** 终端里打 trace 摘要，CLI 用 */
export function formatSummary(s: TraceSummary = summarize()): string {
  const lines = [
    `\x1b[1m调用 ${s.calls} 次\x1b[0m  ` +
      `token ${s.input}/${s.output}  ` +
      `\x1b[1m成本 ~$${s.cost.toFixed(4)}\x1b[0m  ` +
      `${(s.ms / 1000).toFixed(1)}s`,
  ];
  const flags: string[] = [];
  if (s.cacheHits > 0) flags.push(`缓存命中 ${s.cacheHits}`);
  if (s.retries > 0) flags.push(`重试 ${s.retries}`);
  if (s.errors > 0) flags.push(`\x1b[31m失败 ${s.errors}\x1b[0m`);
  if (flags.length > 0) lines.push(`\x1b[90m${flags.join("  ")}\x1b[0m`);

  if (s.byLabel.length > 1) {
    lines.push(`\x1b[90m成本归因：\x1b[0m`);
    for (const g of s.byLabel) {
      const pct = s.cost > 0 ? ((g.cost / s.cost) * 100).toFixed(0) : "0";
      lines.push(
        `\x1b[90m  ${g.label.padEnd(22)} ${g.calls} 次  ` +
          `$${g.cost.toFixed(4)}  ${pct}%\x1b[0m`,
      );
    }
  }
  return lines.join("\n");
}
