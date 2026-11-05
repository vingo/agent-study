/**
 * 断言层 —— 拿原始文档当标准答案，检查 spec 有没有漏、有没有编。
 *
 * 为什么必须有这一层：编译门禁（verify.ts）只回答「是不是合法 TS」，
 * 它对「漏了一整个 interface」是绿的。实测踩过：文档里有 UserInfo，
 * 产物里没有，verify 全绿，靠肉眼 diff 才发现。
 *
 * 这一层回答的是「生成得对不对」：
 *   · 文档里的 interface / 字段，产物里在不在      —— 漏没漏
 *   · 产物里的 interface / 字段，文档里有没有      —— 编没编
 *   · 类型映射对不对                                —— Integer 是不是 number
 *   · 注释是照抄的还是自己发挥的
 *
 * 注意这层是【纯代码】判定，不调模型。用模型评模型在这个场景是浪费 ——
 * 字段对不对是可枚举的事实，不需要推理。
 *
 * 局限说在前面：文档解析是启发式的，只认你们那种 markdown 表格格式
 * （## 标题 + | 字段 | 类型 | 必填 | 说明 | 表头）。
 * 换一种文档格式就要改 parseDoc。等 case 攒够、格式见得多了，
 * 更稳的做法是每个 case 配一份手写的期望文件，而不是猜文档结构。
 */

import type { DtoSpec } from "./schema.js";

/** 从文档里解析出来的字段 */
export interface DocField {
  name: string;
  /** 文档里的原始类型名，如 "List<Integer>" */
  rawType: string;
  description: string;
  /**
   * 必填。undefined 表示文档那一栏是空的 —— 空着不等于「否」，
   * 是「没说」，这种情况不判，避免误报。
   */
  required?: boolean;
}

export interface DocInterface {
  name: string;
  fields: DocField[];
}

/** 解开 HTML 实体 —— 文档里 List&lt;Integer&gt; 是转义过的 */
function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"');
}

/**
 * 从 ## 标题里抠 interface 名。
 * 「## 请求 QueryCityInfoRequestType」→ QueryCityInfoRequestType
 * 「## CityInfo」                      → CityInfo
 * 取最后一个像类型名的 token，前面的「请求」「响应」是说明文字。
 */
function headingToName(heading: string): string | undefined {
  const tokens = heading.trim().split(/\s+/);
  for (let i = tokens.length - 1; i >= 0; i--) {
    const t = tokens[i]!;
    if (/^I?[A-Z][A-Za-z0-9]*$/.test(t)) return t;
  }
  return undefined;
}

/** 表格行 → 单元格数组。首尾的 | 会产生空串，要去掉 */
function splitRow(line: string): string[] {
  const cells = line.split("|").map((c) => c.trim());
  if (cells[0] === "") cells.shift();
  if (cells[cells.length - 1] === "") cells.pop();
  return cells;
}

function isSeparatorRow(line: string): boolean {
  return /^\|?[\s:|-]+\|?$/.test(line) && line.includes("-");
}

/**
 * 「必填」栏 → boolean。
 * 空着返回 undefined，表示文档没说，断言时跳过 ——
 * 空值当成 false 会造出一堆假失败。
 */
function parseRequired(cell: string | undefined): boolean | undefined {
  const s = cell?.trim();
  if (!s) return undefined;
  if (/^(是|Y|yes|true|必填)$/i.test(s)) return true;
  if (/^(否|N|no|false|非必填|可选)$/i.test(s)) return false;
  return undefined;
}

/**
 * 解析 markdown 文档里的 interface 定义。
 *
 * 认的结构：## 标题，紧跟一个 markdown 表格，表头第一列是字段名、第二列是类型。
 * 表头之后到空行或下一个 ## 为止的行都当数据行。
 */
export function parseDoc(doc: string): DocInterface[] {
  const lines = doc.split("\n");
  const result: DocInterface[] = [];
  let current: DocInterface | undefined;
  let inTable = false;

  for (const raw of lines) {
    const line = raw.trim();

    const heading = line.match(/^#{2,}\s+(.*)$/);
    if (heading) {
      const name = headingToName(heading[1]!);
      current = name ? { name, fields: [] } : undefined;
      if (current) result.push(current);
      inTable = false;
      continue;
    }

    if (!current) continue;

    if (!line.startsWith("|")) {
      inTable = false;
      continue;
    }

    if (isSeparatorRow(line)) {
      inTable = true;
      continue;
    }

    const cells = splitRow(line);
    // 表头行：第一列是「字段」之类的标题，跳过。靠分隔行之后才算数据
    if (!inTable) continue;
    if (cells.length < 2) continue;

    const name = cells[0]!;
    // 合法标识符才算字段，挡掉表头和说明行
    if (!/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(name)) continue;

    current.fields.push({
      name,
      rawType: unescapeHtml(cells[1]!),
      description: unescapeHtml(cells[3] ?? ""),
      required: parseRequired(cells[2]),
    });
  }

  return result.filter((i) => i.fields.length > 0);
}

// ================================================================
// 类型映射的期望值
// ================================================================

/**
 * 文档里的 Java/SOA 类型名 → 期望的 TS 类型。
 *
 * 这份表是【断言用的标准答案】，和 schema.ts 里 .describe() 写给模型的规则
 * 是两份独立的东西 —— 故意的。用同一份就变成自己批自己的卷子：
 * 模型照着规则抄，断言照着同一份规则判，永远一致，测不出任何东西。
 *
 * Long 特意映射成 number，跟 schema 里保持一致。真实仓库如果约定映射成 string
 * （避免超过 Number.MAX_SAFE_INTEGER 掉精度），这里和 schema 要一起改。
 */
const TYPE_MAP: Record<string, string> = {
  string: "string",
  String: "string",
  Date: "string",
  DateTime: "string",
  Integer: "number",
  int: "number",
  Long: "number",
  long: "number",
  Short: "number",
  Double: "number",
  double: "number",
  Float: "number",
  float: "number",
  BigDecimal: "number",
  Boolean: "boolean",
  boolean: "boolean",
  Object: "unknown",
};

export interface ExpectedType {
  /** 期望的 TS 类型；引用类型时是 interface 名 */
  type: string;
  isArray: boolean;
  isReference: boolean;
}

/**
 * 把文档里的原始类型名翻译成期望的 TS 类型。
 * 认不出来的（Map<String,Object> 这类）返回 undefined，调用方跳过不判 ——
 * 宁可漏判也不要误判，误判会让你去改一个本来是对的 prompt。
 */
export function expectedType(rawType: string): ExpectedType | undefined {
  const raw = rawType.trim();

  // List<X> / Array<X> / Set<X> / X[]
  const generic = raw.match(/^(?:List|Array|Set|Collection)\s*<\s*(.+?)\s*>$/);
  const bracket = raw.match(/^(.+?)\s*\[\s*\]$/);
  const inner = generic?.[1] ?? bracket?.[1];

  if (inner) {
    const base = expectedType(inner);
    if (!base || base.isArray) return undefined; // 嵌套数组不判
    return { ...base, isArray: true };
  }

  const mapped = TYPE_MAP[raw];
  if (mapped) return { type: mapped, isArray: false, isReference: false };

  // 认不出的 Map / 泛型等，跳过
  if (/[<>,\[\]]/.test(raw)) return undefined;

  // 像类型名的当引用处理
  if (/^I?[A-Z][A-Za-z0-9]*$/.test(raw)) {
    return { type: raw, isArray: false, isReference: true };
  }

  return undefined;
}

// ================================================================
// 断言
// ================================================================

/**
 * 严重程度。分两档是因为处理方式不同：
 *   fail —— 确定错了。漏字段、编字段、类型映射错，都是硬伤
 *   warn —— 可疑但不一定错。注释对不上可能是文档本身排版怪
 * 通过率只算 fail，warn 单独列出来给人看。
 */
export type Severity = "fail" | "warn";

export interface Violation {
  severity: Severity;
  /** 归类，方便统计「模型最常犯哪种错」 */
  rule:
    | "missing-interface"
    | "extra-interface"
    | "missing-field"
    | "extra-field"
    | "wrong-type"
    | "wrong-array"
    | "wrong-reference"
    | "wrong-required"
    | "description-mismatch";
  /** 出问题的位置，如 "CityInfo.glat" */
  where: string;
  message: string;
}

export interface AssertResult {
  ok: boolean;
  violations: Violation[];
  stats: {
    docInterfaces: number;
    specInterfaces: number;
    docFields: number;
    specFields: number;
  };
}

/** 比较 interface 名时忽略 I 前缀 —— 命名风格是渲染层的事，不是模型的事 */
function bare(name: string): string {
  return name.replace(/^I(?=[A-Z])/, "");
}

/** 注释比较：空白和全角/半角标点的差异不算错 */
function normalizeDesc(s: string): string {
  return s
    .replace(/\s+/g, "")
    .replace(/[；;]/g, ";")
    .replace(/[，,]/g, ",")
    .replace(/[：:]/g, ":")
    .toLowerCase();
}

/**
 * 拿文档当标准答案检查 spec。
 *
 * 检查项按「能不能确定是错的」分档，别把可疑当确定 ——
 * 误报会让你去改一个本来是对的 prompt，比漏报更浪费时间。
 */
export function assertSpec(doc: string, spec: DtoSpec): AssertResult {
  const docInterfaces = parseDoc(doc);
  const violations: Violation[] = [];

  const docByName = new Map(docInterfaces.map((i) => [bare(i.name), i]));
  const specByName = new Map(spec.interfaces.map((i) => [bare(i.name), i]));

  // 1. interface 级别：漏了 / 多了
  for (const [name] of docByName) {
    if (!specByName.has(name)) {
      violations.push({
        severity: "fail",
        rule: "missing-interface",
        where: name,
        message: `文档里有 ${name}，产物里没有`,
      });
    }
  }
  for (const [name] of specByName) {
    if (!docByName.has(name)) {
      violations.push({
        severity: "fail",
        rule: "extra-interface",
        where: name,
        message: `产物里的 ${name} 在文档里找不到，可能是模型编的`,
      });
    }
  }

  // 2. 字段级别
  for (const [name, docIface] of docByName) {
    const specIface = specByName.get(name);
    if (!specIface) continue;

    const specFields = new Map(specIface.fields.map((f) => [f.name, f]));
    const docFieldNames = new Set(docIface.fields.map((f) => f.name));

    for (const docField of docIface.fields) {
      const where = `${name}.${docField.name}`;
      const specField = specFields.get(docField.name);

      if (!specField) {
        violations.push({
          severity: "fail",
          rule: "missing-field",
          where,
          message: `文档里有这个字段，产物里没有`,
        });
        continue;
      }

      // 类型映射。认不出的原始类型跳过不判
      const want = expectedType(docField.rawType);
      if (want) {
        if (want.isArray !== specField.isArray) {
          violations.push({
            severity: "fail",
            rule: "wrong-array",
            where,
            message: `${docField.rawType} 期望 isArray=${want.isArray}，实际 ${specField.isArray}`,
          });
        }
        if (want.isReference !== specField.isReference) {
          violations.push({
            severity: "fail",
            rule: "wrong-reference",
            where,
            message: `${docField.rawType} 期望 isReference=${want.isReference}，实际 ${specField.isReference}`,
          });
        }
        // 引用类型忽略 I 前缀比较
        const gotType = want.isReference ? bare(specField.type) : specField.type;
        const wantType = want.isReference ? bare(want.type) : want.type;
        if (gotType !== wantType) {
          violations.push({
            severity: "fail",
            rule: "wrong-type",
            where,
            message: `${docField.rawType} 期望 ${wantType}，实际 ${specField.type}`,
          });
        }
      }

      // 必填。文档那栏空着就是「没说」，不判
      if (docField.required !== undefined && docField.required !== specField.required) {
        violations.push({
          severity: "fail",
          rule: "wrong-required",
          where,
          message: `文档标「${docField.required ? "是" : "否"}」，产物 required=${specField.required}`,
        });
      }

      // 注释。文档没写说明就不判；写了但对不上只报 warn
      const wantDesc = normalizeDesc(docField.description);
      if (wantDesc) {
        const gotDesc = normalizeDesc(specField.description ?? "");
        if (!gotDesc) {
          violations.push({
            severity: "warn",
            rule: "description-mismatch",
            where,
            message: `文档写了说明「${docField.description}」，产物里注释是空的`,
          });
        } else if (gotDesc !== wantDesc) {
          violations.push({
            severity: "warn",
            rule: "description-mismatch",
            where,
            message: `注释和文档不一致。文档「${docField.description}」，产物「${specField.description}」`,
          });
        }
      }
    }

    // 产物里多出来的字段
    for (const specField of specIface.fields) {
      if (!docFieldNames.has(specField.name)) {
        violations.push({
          severity: "fail",
          rule: "extra-field",
          where: `${name}.${specField.name}`,
          message: `这个字段在文档里找不到，可能是模型编的`,
        });
      }
    }
  }

  return {
    ok: violations.every((v) => v.severity !== "fail"),
    violations,
    stats: {
      docInterfaces: docInterfaces.length,
      specInterfaces: spec.interfaces.length,
      docFields: docInterfaces.reduce((n, i) => n + i.fields.length, 0),
      specFields: spec.interfaces.reduce((n, i) => n + i.fields.length, 0),
    },
  };
}

/** 终端输出用 */
export function formatViolations(violations: Violation[]): string {
  return violations
    .map((v) => {
      const tag = v.severity === "fail" ? "\x1b[31m✗\x1b[0m" : "\x1b[33m!\x1b[0m";
      return `  ${tag} ${v.where}  ${v.message} \x1b[90m(${v.rule})\x1b[0m`;
    })
    .join("\n");
}
