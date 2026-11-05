/**
 * SLB Portal HTTP 客户端 —— 纯粹的管道，没有学习价值，我写。
 *
 * 三个函数对应 slb-app-query skill 里的三步 API。
 * 它们只负责发请求和抛错，「错误信息怎么措辞给模型看」不在这里，
 * 那是 server.ts 的事，也是这一阶段的重点。
 */

const BASE_URL = "http://slbportal.ctripcorp.com";

/**
 * Cookie 失效或未配置时抛这个。
 *
 * 注意 SLB Portal 用 HTTP 500 表达认证失败，不是 401 ——
 * 实测响应体是 {"message":"User is not authorized.User: null,...","code":"AuthorizeException"}。
 * 所以判断认证失败不能只看状态码，得看 body。
 */
export class SlbAuthError extends Error {
  constructor() {
    super("SLB Portal 认证失败");
    this.name = "SlbAuthError";
  }
}

/** 资源不存在（groupId / appId 查不到），区别于没权限 */
export class SlbNotFoundError extends Error {
  constructor(what: string) {
    super(what);
    this.name = "SlbNotFoundError";
  }
}

/** 网络层面的失败（超时、不在内网、DNS 挂了） */
export class SlbNetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = "SlbNetworkError";
  }
}

/**
 * Cookie 是可选的 —— 实测三个 API 里只有 group 那个需要登录态：
 *   /api/tools/visit       不需要
 *   /proxy/sgp/api/group   需要
 *   /proxy/sgp/api/apps    不需要
 * 所以没配 Cookie 也能用掉三分之二的功能，不该在入口就拦死。
 */
function headers(): Record<string, string> {
  const c = process.env.SLB_COOKIE;
  return c ? { Cookie: c } : {};
}

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      headers: headers(),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    throw new SlbNetworkError(err);
  }

  const body = await res.text();

  // 认证失败走的是 500 + AuthorizeException，不是 401，所以必须看 body
  if (res.status === 401 || res.status === 403 || body.includes("AuthorizeException")) {
    throw new SlbAuthError();
  }
  // 404 是「查不到这个 id」，和没权限是两回事，分开抛
  if (res.status === 404 || body.includes("NotFoundException")) {
    throw new SlbNotFoundError(`SLB Portal 上找不到该资源`);
  }
  if (!res.ok) {
    throw new Error(`SLB Portal 返回 ${res.status}: ${body.slice(0, 200)}`);
  }

  try {
    return JSON.parse(body) as T;
  } catch {
    throw new Error(`SLB Portal 返回的不是合法 JSON: ${body.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------- 三步 API

export interface VisitResult {
  group: string;          // groupId，"-1" 表示没找到
  env?: string;
  status?: string;
  code?: number;
  "host-ip"?: string;
}

/** Step 1: URL → groupId */
export function queryGroupId(url: string) {
  return get<VisitResult>(`/api/tools/visit?timeout=1200&url=${encodeURIComponent(url)}`);
}

export interface GroupDetail {
  id: number;
  "app-id": string;
  name: string;
  ssl?: boolean;
  properties?: Array<{ name: string; value: string }>;
  "group-servers"?: Array<{ ip: string; port: number; "host-name"?: string; az?: string; weight?: number }>;
  "group-virtual-servers"?: Array<Record<string, unknown>>;
}

/** Step 2: groupId → group 详情（含 appId） */
export function queryGroupDetail(groupId: string) {
  return get<GroupDetail>(`/proxy/sgp/api/group?type=EXTENDED&groupId=${encodeURIComponent(groupId)}`);
}

export interface AppInfo {
  "app-id": string;
  "chinese-name"?: string;
  "english-name"?: string;
  description?: string;
  owner?: string;
  "owner-email"?: string;
  sbu?: string;
  "sbu-code"?: string;
  container?: string;
  "app-importance"?: string;
  "app-category"?: string;
  pci?: boolean;
}

/** apps 接口的真实响应是个分页壳子，不是扁平对象（skill 文档里没写这层） */
interface AppsResponse {
  total: number;
  apps?: AppInfo[];
}

/**
 * Step 3: appId → 应用信息
 *
 * 实测响应是 {total, apps:[...]}，这里剥掉外层壳子只返回第一条。
 * skill 的 SKILL.md 只列了字段名没给完整结构，照着写会踩坑 ——
 * 工具的返回结构必须实测确认，文档不等于实况。
 */
export async function queryAppInfo(appId: string): Promise<AppInfo> {
  const r = await get<AppsResponse>(`/proxy/sgp/api/apps?appId=${encodeURIComponent(appId)}`);
  const app = r.apps?.[0];
  if (!app) throw new SlbNotFoundError(`appId ${appId} 在 SLB Portal 上查不到`);
  return app;
}
