/**
 * 连通性自检。先跑这个，确认认证和网关没问题，再去写 index.ts 的循环。
 * 跑：npm run check
 */
import Anthropic from "@anthropic-ai/sdk";

const { ANTHROPIC_BASE_URL, ANTHROPIC_AUTH_TOKEN } = process.env;

if (!ANTHROPIC_BASE_URL || !ANTHROPIC_AUTH_TOKEN) {
  console.error("✗ 环境变量缺失：");
  console.error(`  ANTHROPIC_BASE_URL   ${ANTHROPIC_BASE_URL ? "✓" : "✗ 未设置"}`);
  console.error(`  ANTHROPIC_AUTH_TOKEN ${ANTHROPIC_AUTH_TOKEN ? "✓" : "✗ 未设置"}`);
  console.error("\n它们在你的 ~/.zshrc 里，开个新终端应该就有了。");
  process.exit(1);
}

console.log(`网关 ${ANTHROPIC_BASE_URL}`);
console.log(`令牌 已设置（${ANTHROPIC_AUTH_TOKEN.length} 字符）\n`);

const client = new Anthropic({
  baseURL: ANTHROPIC_BASE_URL,
  authToken: ANTHROPIC_AUTH_TOKEN,
});

const res = await client.messages.create({
  model: "claude-sonnet-5",
  max_tokens: 256,
  tools: [
    {
      name: "read_file",
      description: "读取一个文件的内容",
      input_schema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ],
  messages: [{ role: "user", content: "帮我读一下 package.json" }],
});

console.log("content blocks:", res.content.map((b) => b.type).join(" → "));
console.log("stop_reason:  ", res.stop_reason);
console.log("tokens:       ", `in ${res.usage.input_tokens} / out ${res.usage.output_tokens}`);

if (res.stop_reason === "tool_use") {
  const call = res.content.find((b) => b.type === "tool_use");
  console.log("\n✓ 通了。模型请求调用:", JSON.stringify(call));
  console.log("\n注意 content blocks 的顺序 —— 第一个不是 tool_use。");
  console.log("在 index.ts 里千万别写 content[0]，要按 type 过滤。");
} else {
  console.log(`\n⚠️  预期 stop_reason 是 tool_use，实际是 ${res.stop_reason}。`);
  console.log("模型可能没理解要调工具，但认证和网关是通的，可以继续。");
}
