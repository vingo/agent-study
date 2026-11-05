import fs from "node:fs/promises";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: process.env.ANTHROPIC_BASE_URL,
  authToken: process.env.ANTHROPIC_AUTH_TOKEN,
});
const MODEL = "claude-sonnet-5";
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
const WORKSPACE = process.cwd();

const executeTool = async (name: string, input: unknown): Promise<string> => {
  if (name !== "read_file") {
    return `错误：不存在名为 ${name} 的工具。可用工具：read_file`;
  }

  const rel = (input as { path?: unknown }).path;
  if (typeof rel !== "string") {
    return `错误：read_file 工具的输入必须是一个对象，且包含字符串类型的 path 属性。`;
  }

  const abs = path.join(WORKSPACE, rel);
  try {
    const content = await fs.readFile(abs, "utf-8");
    return content;
  } catch (err) {
    return `错误：无法读取文件 ${rel}，请检查路径是否正确。`;
  }
}

const MAX_TURNS = 5;// 最大轮训数量
const main = async (prompt: string) => {
    const messages: Anthropic.MessageParam[] = [{
        role: "user",
        content: prompt
    }];
    for (let turn = 1; turn <= MAX_TURNS; turn++) {
        console.log(`\n\x1b[90m[第 ${turn} 轮] 当前消息记录长度：${messages.length}\x1b[0m`);
        console.log('>>>>>messages', JSON.stringify(messages));
        const result = await client.messages.create({
            model: MODEL,
            max_tokens: 2000,
            tools,
            messages: messages,
        })
        const contents = result.content
        console.log('>>>>>>>>result: ', result.stop_reason, JSON.stringify(result));
        messages.push({ role: "assistant", content: result.content });
        for (const block of contents ?? []) {
            if (block.type === "thinking") {
                console.log('[THINKING]',block.thinking);
            } else if (block.type === "tool_use") {
                // TODO : 现在是循环串行，后续可以优化为并行执行
                const tool_result = await executeTool(block.name, block.input);
                messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: block.id, content: tool_result }] });
            } else if (block.type === "text") {
                console.log('[TEXT]',block.text);
            }
        }
        if (result.stop_reason === "end_turn") {
            console.log("\n\x1b[90m[循环结束] 模型说完了，退出。\x1b[0m");
            console.log('【结果记录】messages', JSON.stringify(messages));
            return
        } else if (result.stop_reason === "max_tokens") {
            console.log("\n\x1b[90m[循环结束] 模型达到 max_tokens 上限，退出。\x1b[0m");
            console.log('【结果记录】messages', JSON.stringify(messages));
            return
        }
        continue;
    }
    console.log(`\n⚠️  达到 ${MAX_TURNS} 轮上限，强制退出。`);
}

const prompt =
  process.argv.slice(2).join(" ") ||
  "读一下 package.json，告诉我这个项目装了哪些依赖，以及它是 ESM 还是 CommonJS。";

console.log(`\x1b[1m[任务]\x1b[0m ${prompt}`);
main(prompt).catch(err => {
    console.error('运行出错', err);
});