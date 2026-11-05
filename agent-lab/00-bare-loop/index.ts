/**
 * 阶段 0：不用任何框架，手写一个 agent。
 *
 * 已经给你的：client、工具声明、工具执行器、日志。
 * 留给你的：run() 里的循环体。这 30 行是这个练习的全部价值所在。
 *
 * 跑：npm start
 */
import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

// ---------------------------------------------------------------- 客户端

// 走携程内网网关。注意是 authToken 而不是 apiKey：
// authToken 发的是 `Authorization: Bearer xxx`，apiKey 发的是 `x-api-key: xxx`，
// 这个网关只认前者。
const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
  authToken: process.env.ANTHROPIC_AUTH_TOKEN,
});
const MODEL = "claude-sonnet-5";

// ---------------------------------------------------------------- 工具声明

// 这就是「工具」的全部：一个名字、一段给模型看的说明、一个 JSON Schema。
// description 是写给模型的 prompt，不是写给人看的注释 —— 模型靠它决定要不要调、怎么调。
const tools: Anthropic.Tool[] = [
  {
    name: "read_file",
    description:
      "读取工作目录下一个文件的完整内容。传入相对路径。" +
      "只在需要知道文件里具体写了什么时使用；如果只是想知道有哪些文件，不要用这个工具。",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "相对于工作目录的文件路径，例如 package.json",
        },
      },
      required: ["path"],
    },
  },
];

// ---------------------------------------------------------------- 工具执行

const WORKSPACE = process.cwd();

/**
 * 真正去执行工具。返回的字符串会原样进入模型的上下文。
 *
 * 注意错误处理的写法：不返回 stack trace，而是返回一句模型能照着改的话。
 * 这是阶段 1 的核心直觉，这里先埋下：工具的返回值是给模型看的，不是给程序看的。
 */
async function executeTool(name: string, input: unknown): Promise<string> {
  if (name !== "read_file") {
    return `错误：不存在名为 ${name} 的工具。可用工具：read_file`;
  }

  const rel = (input as { path?: unknown }).path;
  if (typeof rel !== "string" || rel.length === 0) {
    return "错误：缺少必需参数 path。请传入一个字符串，例如 { \"path\": \"package.json\" }";
  }

  // 别让模型读到工作目录外面去。阶段 3 会专门讲这类边界，
  // 但从第一天起就该这么写。
  const abs = path.resolve(WORKSPACE, rel);
  if (!abs.startsWith(WORKSPACE + path.sep) && abs !== WORKSPACE) {
    return `错误：路径 ${rel} 超出了工作目录，拒绝访问。请使用工作目录内的相对路径。`;
  }

  try {
    return await fs.readFile(abs, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return `错误：文件 ${rel} 不存在。请确认路径拼写，或先确认这个文件是否在工作目录下。`;
    }
    if (code === "EISDIR") {
      return `错误：${rel} 是一个目录而不是文件。请指定具体的文件路径。`;
    }
    return `错误：读取 ${rel} 失败（${code ?? "unknown"}）。`;
  }
}

// ---------------------------------------------------------------- 日志

// 把每一轮发生了什么打出来。手写 agent 最重要的收获之一，
// 就是亲眼看清 messages 数组是怎么一轮轮长起来的。
const log = {
  turn: (n: number) => console.log(`\n${"─".repeat(20)} 第 ${n} 轮 ${"─".repeat(20)}`),
  thinking: (t: string) => t.trim() && console.log(`\x1b[90m[思考] ${t.trim()}\x1b[0m`),
  text: (t: string) => console.log(`\x1b[36m[模型]\x1b[0m ${t.trim()}`),
  toolCall: (name: string, input: unknown) =>
    console.log(`\x1b[33m[调用]\x1b[0m ${name}(${JSON.stringify(input)})`),
  toolResult: (r: string) => {
    const preview = r.length > 200 ? r.slice(0, 200) + `… (共 ${r.length} 字符)` : r;
    console.log(`\x1b[32m[结果]\x1b[0m ${preview.replace(/\n/g, "\n       ")}`);
  },
  stop: (reason: string | null) => console.log(`\x1b[90m[停止] stop_reason = ${reason}\x1b[0m`),
};

// ---------------------------------------------------------------- 主循环

const MAX_TURNS = 5;

async function run(userPrompt: string) {
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userPrompt },
  ];

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    log.turn(turn);

    // ========================= 你来写 =========================
    //
    // 目标：把这个循环填完，让它能自主多轮调用工具直到任务完成。
    // 先跑通再优化，别一次写完整个循环 —— 按下面四步，每步跑一次。
    //
    // 第 1 步 · 发请求
    //   调 client.messages.create({ model, max_tokens, tools, messages })。
    //   先 console.log 整个响应对象，看清它长什么样。
    //   这一步跑通就说明认证没问题，可以往下走了。
    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 2000,
      tools,
      messages,
    })
    //
    // 第 2 步 · 读响应
    //   response.content 是一个 block 数组，按 type 分流：
    //   "thinking" | "text" | "tool_use"。用上面的 log.* 打出来。
    //   ⚠️ 别写 content[0] —— 网关会先返回 thinking block，
    //      要用 .filter() 按 type 取，不能靠下标。
    const contents = response?.content;
    // console.log(">>>>>>>>>>contents", contents);
    //
    // 第 3 步 · 判断要不要继续
    //   看 response.stop_reason：
    //     "end_turn"  → 模型说完了，return 退出循环
    //     "tool_use"  → 它想调工具，继续往下
    //
    // 第 4 步 · 执行工具并闭环
    //   a. 先把模型这条完整回复推进历史：
    //      messages.push({ role: "assistant", content: response.content })
    //      ⚠️ 漏了这步 API 会直接报错，这是最常见的坑。
    messages.push({ role: "assistant", content: response.content });
    //   b. 对每个 tool_use block 调 executeTool()。
    //   c. 把结果拼成 tool_result block 数组，推进历史：
    //      { type: "tool_result", tool_use_id: <block.id>, content: <结果字符串> }
    //      ⚠️ tool_use_id 必须和 block.id 完全一致。
    //      ⚠️ 这些 tool_result 要放在 role: "user" 的消息里 —— 不是 assistant。
    //         反直觉但没错：从 API 视角看，工具结果是「外部世界告诉模型的信息」，
    //         和用户输入同一个角色。
    for (const block of contents ?? []) {
      if (block.type === "thinking") {
        log.thinking(block.thinking);
      }
      else if (block.type === "tool_use") {
        const toolName = block.name;
        const toolInput = block.input;
        log.toolCall(toolName, toolInput);
        const result = await executeTool(toolName, toolInput);
        log.toolResult(result);
        messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: block.id, content: result }] });
      }
      else if (block.type === "text") {
        log.text(block.text);
      }
    }

    if (response?.stop_reason === "end_turn") {
      console.log("\n\x1b[90m[循环结束] 模型说完了，退出。\x1b[0m");
      console.log('【结果记录】messages', JSON.stringify(messages));
      return
    } else if (response?.stop_reason === "max_tokens") {
      console.log("\n\x1b[90m[循环结束] 模型达到 max_tokens 上限，退出。\x1b[0m");
      console.log('【结果记录】messages', JSON.stringify(messages));
      return
    }
    //   d. 然后 continue，让循环跑下一轮。
    continue;

    //
    // 写完回头看一眼 messages 数组的长度和结构，
    // 你会发现所谓 agent 就是在往这个数组里追加内容。
    //
    // ==========================================================
  }

  console.log(`\n⚠️  达到 ${MAX_TURNS} 轮上限，强制退出。`);
}

// ---------------------------------------------------------------- 入口

const prompt =
  process.argv.slice(2).join(" ") ||
  "读一下 package.json，告诉我这个项目装了哪些依赖，以及它是 ESM 还是 CommonJS。";

console.log(`\x1b[1m[任务]\x1b[0m ${prompt}`);

run(prompt).catch((err) => {
  console.error("\n\x1b[31m[出错]\x1b[0m", err instanceof Error ? err.message : err);
  process.exit(1);
});
