/**
 * MCP 工具层测试台。真正走 MCP 协议调用你注册的工具，看模型会看到什么。
 *
 * 和 probe.ts 的区别：
 *   probe  → 直接调 slb.ts 的函数，看原始 API 响应
 *   call   → 走完整 MCP 协议，看你的工具最终返回给模型的文本
 *
 * 这个区别很重要：模型看到的是 call 的输出，不是 probe 的输出。
 * 调措辞要看这个。
 *
 * 跑：npm run call                              列出所有工具及其 description
 *     npm run call slb_app_info 100014416
 *     npm run call slb_url_to_group https://www.trip.com
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [toolName, ...args] = process.argv.slice(2);

// 起一个子进程跑 server.ts，然后用 MCP 客户端连上去 —— 和 Claude Code 做的事一样
const transport = new StdioClientTransport({
  command: "npx",
  args: ["tsx", "server.ts"],
  env: { ...process.env } as Record<string, string>,
});

const client = new Client({ name: "call-harness", version: "1.0.0" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log('>>>>【tools】>>>>>>', tools)

if (!toolName) {
  console.log(`\n已注册 ${tools.length} 个工具：\n`);
  for (const t of tools) {
    console.log(`\x1b[1m${t.name}\x1b[0m`);
    // 这段就是模型看到的 description —— 它靠这个决定要不要调你的工具
    console.log(`  ${t.description?.replace(/\n/g, "\n  ")}`);
    const props = t.inputSchema?.properties as Record<string, { description?: string }> | undefined;
    for (const [k, v] of Object.entries(props ?? {})) {
      console.log(`  └ ${k}: ${v.description ?? "(无说明)"}`);
    }
    console.log();
  }
  console.log("调用：npm run call <工具名> <参数值>");
  await client.close();
  process.exit(0);
}

const tool = tools.find((t) => t.name === toolName);
if (!tool) {
  console.error(`没有叫 ${toolName} 的工具。已注册：${tools.map((t) => t.name).join(", ")}`);
  await client.close();
  process.exit(1);
}

// 按 schema 里声明的参数顺序，把命令行参数依次填进去
const keys = Object.keys((tool.inputSchema?.properties ?? {}) as Record<string, unknown>);
const params = Object.fromEntries(keys.map((k, i) => [k, args[i]]).filter(([, v]) => v !== undefined));

console.log(`\n\x1b[90m调用 ${toolName}(${JSON.stringify(params)})\x1b[0m`);
console.log(`\x1b[90m${"─".repeat(60)}\x1b[0m`);

const res = await client.callTool({ name: toolName, arguments: params });

// 这就是模型实际看到的内容
for (const block of (res.content ?? []) as Array<{ type: string; text?: string }>) {
  if (block.type === "text") console.log(block.text);
  else console.log(`[${block.type} block]`);
}

console.log(`\x1b[90m${"─".repeat(60)}\x1b[0m`);
console.log(`\x1b[90m以上是模型看到的全部内容。问自己：它够不够模型判断下一步？\x1b[0m`);

await client.close();
