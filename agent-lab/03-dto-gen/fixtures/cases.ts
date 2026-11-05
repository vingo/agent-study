/**
 * eval 的 case 清单。
 *
 * 分两类，因为它们测的是不同的东西：
 *
 *   doc  —— v1 单轮。我把文档内容塞给模型，看它抽取得对不对。
 *           测的是「理解文档」的能力，跑得快、便宜。
 *
 *   repo —— v3 多轮。只给它一个仓库根目录，它自己找文档、找参考文件、
 *           判断命名风格。测的是「探索 + 遵守局部约定」的能力。
 *           慢且贵（一次 10 多轮、两万 token），但这才是 v3 的价值所在。
 *
 * 为什么要分开而不是全用 repo：doc case 能精确定位「是不是文档理解错了」，
 * repo case 失败时原因可能在探索、可能在理解，混在一起不好归因。
 * 便宜的测试覆盖广，贵的测试测关键路径 —— 和后端测试金字塔一个思路。
 */
import type { NamingStyle } from "../src/render.js";

export interface DocCase {
  kind: "doc";
  name: string;
  /** 文档路径 */
  doc: string;
}

export interface RepoCase {
  kind: "repo";
  name: string;
  /** 仓库根，agent 的沙箱 */
  root: string;
  /** 指定文档；不给就让 agent 自己找 */
  doc?: string;
  /** 用来跑断言的文档路径（相对 root） */
  docForAssert: string;
  /**
   * 期望的命名风格。这是 v3 的核心断言 ——
   * 模型必须从目标目录的邻居文件推断出来，不能靠全局习惯猜。
   */
  expectStyle: NamingStyle;
}

export type EvalCase = DocCase | RepoCase;

export const CASES: EvalCase[] = [
  // ---- v1：文档理解 ----
  { kind: "doc", name: "queryCityInfo", doc: "fixtures/queryCityInfo.md" },
  { kind: "doc", name: "searchHotelList", doc: "fixtures/searchHotelList.md" },
  { kind: "doc", name: "createOrder", doc: "fixtures/createOrder.md" },
  { kind: "doc", name: "queryFlightPrice", doc: "fixtures/queryFlightPrice.md" },

  // ---- v3：探索 + 局部约定 ----
  // 同一个仓库、两个风格相反的目录。这一对是 v3 的关键断言：
  // 模型必须分别推断出 plain 和 i-prefix，猜一个固定值必错一半
  {
    kind: "repo",
    name: "repo:geo-plain",
    root: "fixtures/repo",
    doc: "src/common/api/docs/queryDistrictList.md",
    docForAssert: "src/common/api/docs/queryDistrictList.md",
    expectStyle: "plain",
  },
  {
    kind: "repo",
    name: "repo:hotel-iprefix",
    root: "fixtures/repo",
    doc: "src/common/api/docs/refundOrder.md",
    docForAssert: "src/common/api/docs/refundOrder.md",
    expectStyle: "i-prefix",
  },
  // 不指定文档，让它自己找 —— 测的是探索能力本身。
  // 仓库里有两份文档，它得自己选一份并且自洽（选 geo 的就用 plain）
  // 难 case：12 个 interface、三层嵌套、末尾的 InvoiceInfo 最容易漏。
  // 建它的目的是让 eval 有区分度 —— 全绿的 eval 和没有 eval 差别不大，
  // 而 Reflexion 这类多轮试错框架必须有失败样本才测得出价值
  {
    kind: "repo",
    name: "repo:hard-12ifaces",
    root: "fixtures/repo-hard",
    doc: "src/common/api/docs/queryItineraryDetail.md",
    docForAssert: "src/common/api/docs/queryItineraryDetail.md",
    expectStyle: "i-prefix",
  },
  {
    kind: "repo",
    name: "repo:self-discover",
    root: "fixtures/repo-single",
    docForAssert: "src/common/api/docs/queryAirportList.md",
    expectStyle: "i-prefix",
  },
];
