/**
 * 本地测试台。不启动 MCP 协议，直接调工具函数看返回值。
 *
 * 为什么需要这个：接进 Claude Code 后每改一行都要重启客户端，太慢。
 * 先在这里把返回值措辞调顺，再接进去。
 *
 * 跑：npm run probe                        列出已注册的工具
 *     npm run probe slb_url_to_group https://www.trip.com
 */
import { queryGroupId, queryGroupDetail, queryAppInfo, SlbAuthError, SlbNetworkError, SlbNotFoundError } from "./slb.js";

const [toolName, ...args] = process.argv.slice(2);

if (!toolName) {
  console.log(`
可用的探测命令：

  npm run probe url    <URL>       走 Step 1，URL → groupId        （不需要 Cookie）
  npm run probe group  <groupId>   走 Step 2，groupId → group 详情  （需要 Cookie）
  npm run probe app    <appId>     走 Step 3，appId → 应用信息      （不需要 Cookie）
  npm run probe chain  <URL>       三步串起来跑一遍

这里打印的是【未经加工的原始响应】—— 先看清原始数据长什么样，
再决定你的工具该返回什么给模型。这两者的差距就是这一阶段的功课。

没配 Cookie 时 url 和 app 两个命令照样能跑，只有 group 会报认证失败。
`);
  process.exit(0);
}

function show(label: string, data: unknown) {
  console.log(`\n\x1b[1m=== ${label} ===\x1b[0m`);
  const json = JSON.stringify(data, null, 2);
  console.log(json.length > 4000 ? json.slice(0, 4000) + `\n… (共 ${json.length} 字符)` : json);
}

try {
  switch (toolName) {
    case "url": {
      const url = args[0];
      if (!url) throw new Error("用法: npm run probe url <URL>");
      show("Step 1: URL → groupId", await queryGroupId(url));
      break;
    }
    case "group": {
      const gid = args[0];
      if (!gid) throw new Error("用法: npm run probe group <groupId>");
      const d = await queryGroupDetail(gid);
      show("Step 2: group 详情（原始）", d);
      console.log(`\n\x1b[33m注意\x1b[0m properties 有 ${d.properties?.length ?? 0} 条，` +
        `group-servers 有 ${d["group-servers"]?.length ?? 0} 台。`);
      console.log("全部塞给模型是浪费注意力 —— 想想排查问题时真正需要哪几个。");
      break;
    }
    case "app": {
      const aid = args[0];
      if (!aid) throw new Error("用法: npm run probe app <appId>");
      show("Step 3: 应用信息（原始）", await queryAppInfo(aid));
      break;
    }
    case "chain": {
      const url = args[0];
      if (!url) throw new Error("用法: npm run probe chain <URL>");
      const s1 = await queryGroupId(url);
      show("Step 1", s1);
      if (!s1.group || s1.group === "-1") {
        console.log("\ngroupId 是 -1，链路断了。试试 https:// 开头的 URL。");
        break;
      }
      const s2 = await queryGroupDetail(s1.group);
      show("Step 2", { id: s2.id, "app-id": s2["app-id"], name: s2.name,
        propertiesCount: s2.properties?.length, serversCount: s2["group-servers"]?.length });
      const s3 = await queryAppInfo(s2["app-id"]);
      show("Step 3", s3);
      break;
    }
    default:
      console.error(`未知命令 ${toolName}。跑 npm run probe 看用法。`);
      process.exit(1);
  }
} catch (err) {
  if (err instanceof SlbAuthError) {
    console.error(
      process.env.SLB_COOKIE
        ? "\n\x1b[31m认证失败\x1b[0m Cookie 过期了，去 .env 里更新 SLB_COOKIE。"
        : "\n\x1b[31m认证失败\x1b[0m 这个接口需要 Cookie。只有 group 这一步需要，url 和 app 不需要。",
    );
  } else if (err instanceof SlbNotFoundError) {
    console.error(`\n\x1b[31m查不到\x1b[0m ${err.message}`);
  } else if (err instanceof SlbNetworkError) {
    console.error(`\n\x1b[31m网络错误\x1b[0m ${err.message}\n确认是否在携程内网。`);
  } else {
    console.error(`\n\x1b[31m出错\x1b[0m ${err instanceof Error ? err.message : err}`);
  }
  process.exit(1);
}
