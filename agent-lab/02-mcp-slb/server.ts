/**
 * 阶段 1：写一个自己的 MCP server。
 *
 * 把 ~/.claude/skills/slb-app-query 这个 skill 包成三个 MCP 工具。
 *
 * 已经给你的：MCP server 骨架、HTTP 客户端（slb.ts）、第一个工具的完整实现。
 * 留给你的：第 2、3 个工具。重点不是"能跑"，是 description 和返回值的措辞。
 *
 * 跑：npm run dev（本地手动测）
 * 接进 Claude Code：见 README.md
 *
 * ⚠️ zod 版本必须和 SDK 内部那份完全一致（现在都是 4.6.5，package.json 里已锁死）。
 *    版本不一致时 node_modules 里会出现两份 zod，同名不同源的类型对不上，
 *    registerTool 会报 TS2589「类型实例化过深」，而且报错位置完全指不到真正的原因。
 *    排查方法：npm ls zod --all —— 只要看到不是 deduped 的第二份就是它。
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  queryGroupId,
  queryGroupDetail,
  queryAppInfo,
  SlbAuthError,
  SlbNetworkError,
  SlbNotFoundError,
} from "./slb.js";

const server = new McpServer({ name: "slb-app-query", version: "1.0.0" });

/**
 * 统一的错误措辞。
 *
 * 这个函数是整个练习的核心思想所在，值得多看两眼：
 * 每一句错误信息都在回答模型的一个问题 ——「所以我现在该干什么？」
 *
 * 对比一下不该写的版本：
 *   ❌ throw err                          模型看到 stack trace，无从下手
 *   ❌ return "请求失败"                    模型不知道是不是该重试
 *   ✅ return "Cookie 过期了，需要用户重新登录" 模型知道这不是它能修的，会转而告诉用户
 *
 * 关键区分：这个错误模型能自己解决吗？
 *   能  → 告诉它怎么改（参数错了、格式不对）
 *   不能 → 明确说"这需要用户处理"，避免它徒劳重试
 */
function errorText(err: unknown): string {
  if (err instanceof SlbAuthError) {
    const hasCookie = Boolean(process.env.SLB_COOKIE);
    return [
      hasCookie
        ? "SLB Portal 认证失败，配置的 Cookie 已过期。"
        : "这个接口需要登录态，但本 server 没有配置 Cookie。",
      "这个问题你无法自行解决，需要用户操作，请把下面的步骤转告用户，不要重试：",
      "1. 浏览器登录 http://slbportal.ctripcorp.com",
      "2. 开发者工具 Network 里复制任意请求的 Cookie 请求头",
      "3. 填入本 MCP server 的 .env 文件的 SLB_COOKIE",
      "",
      "补充：slb_url_to_group 和 slb_app_info 不需要 Cookie 也能用。",
      "如果用户只是想知道某个 URL 属于哪个应用，可以先用 slb_url_to_group 拿 groupId，",
      "但从 groupId 到 appId 这一步必须有 Cookie，绕不过去。",
    ].join("\n");
  }
  if (err instanceof SlbNotFoundError) {
    return `${err.message}。请确认 id 是否正确，或改用其他工具从 URL 开始查。`;
  }
  if (err instanceof SlbNetworkError) {
    return [
      `无法连接 SLB Portal：${err.message}`,
      "常见原因是不在携程内网环境。请确认网络后重试，或告知用户检查 VPN。",
    ].join("\n");
  }
  return `查询失败：${err instanceof Error ? err.message : String(err)}`;
}

/** MCP 工具返回值的固定形状，包一下省得每次写 */
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

// ================================================================
// 工具 1 / 3 —— 完整示例，照着这个写另外两个
// ================================================================

server.registerTool(
  "slb_url_to_group",
  {
    description:
      // description 是写给模型的 prompt，不是给人看的文档。
      // 三件事必须说清：这工具干什么、什么时候用、什么时候【不要】用。
      "根据 URL 查询它在 SLB 上的 groupId。这是查询应用信息的第一步，" +
      "拿到 groupId 后需要再调 slb_group_detail 才能得到 appId。" +
      "注意：必须传 https:// 开头的完整 URL，传 http:// 往往因为 301 重定向而查不到。" +
      "如果用户直接给了 appId 或 groupId，不要用这个工具，直接用对应的下一步工具。",
    inputSchema: {
      url: z
        .string()
        .describe("完整的 URL，必须含协议头，优先用 https://，例如 https://www.trip.com"),
    },
  },
  async ({ url }) => {
    try {
      const r = await queryGroupId(url);

      // 业务层面的"没找到"不是异常，但要告诉模型下一步怎么办。
      // 这里是整个练习最值得体会的一处：同样是"查不到"，
      // 返回 "group: -1" 模型只能干瞪眼，返回下面这段它就知道能自己重试。
      if (!r.group || r.group === "-1") {
        const hint = url.startsWith("http://")
          ? `\n你传的是 http://，这是最常见的原因。请改用 https://${url.slice(7)} 重试一次。`
          : "\n可能这个 URL 没有在 SLB 上注册，或者它会重定向到别的域名。";
        return text(`未找到 ${url} 对应的 SLB group。${hint}`);
      }

      return text(
        [
          `groupId: ${r.group}`,
          r.env ? `环境: ${r.env}` : null,
          r["host-ip"] ? `目标 IP: ${r["host-ip"]}` : null,
          r.code ? `HTTP 状态: ${r.code}` : null,
          "",
          `下一步：用 slb_group_detail 查 groupId ${r.group} 的详情，可以拿到 appId。`,
        ]
          .filter(Boolean)
          .join("\n"),
      );
    } catch (err) {
      return text(errorText(err));
    }
  },
);

// ================================================================
// 工具 2 / 3 —— 你来写
// ================================================================
//
// 名字建议 slb_group_detail，输入 groupId，调 queryGroupDetail()。
//
// 返回值里 group 详情字段很多（properties 十几条、group-servers 可能几十台机器），
// 全塞给模型是错的 —— 想想你自己排查问题时真正需要哪几个字段。
// 这就是「上下文的稀缺资源是注意力」的第一次实战。
//
// 三个具体决策留给你：
//   1. properties 是个 name/value 数组，里面 SBU、idc、language、appType 这些有用，
//      其他十几条基本是噪音。要不要挑？挑哪些？
//   2. group-servers 可能有几十台机器的 IP。全列出来？只报数量？还是列前几台？
//      （提示：用户是在排查问题，他想知道什么）
//   3. 拿到 app-id 之后，要不要像工具 1 那样在返回值末尾提示下一步？
//
// ================================================================

server.registerTool(
  "slb_group_detail",
  {
    description:
      // description 是写给模型的 prompt，不是给人看的文档。
      // 三件事必须说清：这工具干什么、什么时候用、什么时候【不要】用。
      "根据 用户请求参数的groupId来查询对应的group信息。" +
      "如果没有 groupId 时，别猜，先用 其它工具 slb_url_to_group 拿 groupId。"+ 
      "如果获取到group信息后可以用 slb_app_info 查 appId 的具体信息，如可以拿到应用负责人等",
    inputSchema: {
      groupId: z
        .string()
        .describe("组的 ID，例如 9004109"),
    },
  },
  async ({ groupId }) => {
    try {
      const r = await queryGroupDetail(groupId);
      const propertieInfo = r.properties?.reduce((acc, p) => {
        if (p.name && p.value) {
          acc[p.name] = p.value;
        }
        return acc;
      }, {} as Record<string, string>) ?? {};
      const downServers = r["group-servers"]?.filter(server => !server.weight) ?? [];
      return text(
        [
          `groupId: ${groupId}`,
          `appId: ${r["app-id"]}`,
          `status: ${propertieInfo.status}`,
          `language: ${propertieInfo.language}`,
          `idc: ${propertieInfo.idc}`,
          downServers?.length ? `异常机器：${downServers.map(s => s.ip).join(',')}`: `${ r["group-servers"]?.length}台正常`,
          "",
          `下一步：用 slb_app_info 查 appId ${r["app-id"]} 的应用信息，可以拿到应用负责人、邮箱、所属 BU。`,
        ].filter(Boolean).join("\n"),
      );
    } catch (err) {
      return text(errorText(err));
    }
  },
);

// ================================================================
// 工具 3 / 3 —— 你来写
// ================================================================
//
// 名字建议 slb_app_info，输入 appId，调 queryAppInfo()。
//
// 这个最简单，字段少，直接铺开就行。
//
// 但有个额外的点值得想：skill 原版有个 app-info-cache.md 缓存机制，
// 说「查询前必须先看缓存」。那是因为 skill 靠模型自觉去读文件。
// 现在执行权在你的代码里了 —— 缓存该怎么做？还需要让模型知道有缓存这回事吗？
// （不用现在实现，想清楚就行，这是阶段 3 的内容）
//
// ================================================================
server.registerTool(
  "slb_app_info",
  {
    description:
      // description 是写给模型的 prompt，不是给人看的文档。
      // 三件事必须说清：这工具干什么、什么时候用、什么时候【不要】用。
      "根据 用户请求参数的appId来查询对应应用的信息（中文名、负责人、邮箱、所属 BU）。" +
      "appId 只有两个合法来源：用户明确说出的，或 slb_group_detail 返回的。" +
      "用户没给 appId 时，不要猜、不要拿本说明和参数示例里的数字去试、也不要用历史对话里查过的 appId 顶替，" +
      "调用本工具时把 appId 留空，工具会告诉你该怎么向用户提问。" +
      "如果只有 URL 没有 appId 时，先用 slb_url_to_group。",
    inputSchema: {
      // 故意设成 optional：设成必填的话，模型漏传时是 SDK 抛 zod 校验错，
      // 措辞我们控制不了，模型很可能就地编一个值重试。
      // 放进来自己校验，才能把"停下来问用户"这条指令说清楚。
      appId: z
        .string()
        .optional()
        .describe(
          "应用的 ID，9 位纯数字。格式形如 100017590 —— 这是格式示例，不是默认值，" +
            "严禁在用户没提供 appId 时拿它来查询。用户没提供就留空。",
        ),
    },
  },
  async ({ appId }) => {
    const id = appId?.trim() ?? "";

    // 参数缺失不是异常，但必须明确告诉模型：这一步你解决不了，去问用户。
    // 不写这段的后果是真实发生过的：模型把 describe 里的示例 appId 当成输入，
    // 查出一个毫不相干的应用，然后当作答案报给用户。
    if (!id) {
      return text(
        [
          "没有收到 appId，查询未执行。",
          "这个问题你无法自行解决，不要猜一个 appId 重试，请向用户提问：",
          "「要查哪个应用？请提供 appId（9 位数字）。如果只知道线上 URL，把 URL 给我，我从 slb_url_to_group 开始查。」",
        ].join("\n"),
      );
    }
    if (!/^\d+$/.test(id)) {
      return text(
        `appId「${id}」不是纯数字，不是合法的 appId，查询未执行。\n` +
          "如果这是应用英文名或域名，本工具查不了：有 URL 就用 slb_url_to_group，" +
          "否则请向用户确认准确的 appId 数字。",
      );
    }

    try {
      const r = await queryAppInfo(id);

      return text(
        [
          // ← 第 4 步写，挑你要的字段
          `appId: ${r["app-id"]}`,
          `name: ${r["chinese-name"]}`,
          `owner: ${r["owner"]}`,
          `email: ${r["owner-email"]}`,
          `bu: ${r.sbu}`,
        ].filter(Boolean).join("\n"),
      );
    } catch (err) {
      return text(errorText(err));
    }
  },
);
// ---------------------------------------------------------------- 启动

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // 注意：MCP server 用 stdout 跟客户端通信，所以日志必须走 stderr。
  // 往 stdout 里 console.log 会污染协议，客户端直接报错。
  console.error("[slb-app-query] MCP server 已启动");
}

main().catch((err) => {
  console.error("[slb-app-query] 启动失败:", err);
  process.exit(1);
});
