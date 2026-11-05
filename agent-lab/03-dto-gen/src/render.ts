/**
 * 把结构化数据渲染成 .interface.ts 文件。纯代码，不涉及模型，我写。
 *
 * 这个文件存在的意义值得注意：模型只负责「理解文档、抽取字段」，
 * 不负责「拼 TypeScript 代码」。让模型直接输出代码字符串是常见的错误做法 ——
 * 它会在缩进、引号、分号上犯随机错误，而且你无法校验。
 * 让它输出结构化数据、由代码渲染，产物就是确定的。
 */
import type { DtoSpec, FieldSpec, InterfaceSpec } from "./schema.js";

/** 你们仓库里两种命名风格混用，让调用方选 */
export type NamingStyle = "plain" | "i-prefix";

function interfaceName(raw: string, style: NamingStyle): string {
  const bare = raw.replace(/^I(?=[A-Z])/, "");
  return style === "i-prefix" ? `I${bare}` : bare;
}

/** 字段注释：单行短注释和多行长注释在你们仓库里都有，统一成多行块 */
function renderComment(desc: string | undefined, indent: string): string[] {
  if (!desc?.trim()) return [];
  const lines = desc.trim().split("\n");
  return [`${indent}/**`, ...lines.map((l) => `${indent} * ${l.trim()}`), `${indent} */`];
}

function renderField(f: FieldSpec, style: NamingStyle, indent: string): string[] {
  // 引用其他 interface 的类型也要跟着改命名风格，否则生成的代码引用不到
  const type = f.isReference ? interfaceName(f.type, style) : f.type;
  const suffix = f.isArray ? "[]" : "";
  const optional = f.required ? "" : "?";
  return [
    ...renderComment(f.description, indent),
    `${indent}${f.name}${optional}: ${type}${suffix}`,
  ];
}

function renderInterface(i: InterfaceSpec, style: NamingStyle): string {
  const body = i.fields.flatMap((f) => renderField(f, style, "    "));
  return [
    ...renderComment(i.description, ""),
    `export interface ${interfaceName(i.name, style)} {`,
    ...body,
    `}`,
  ].join("\n");
}

export function render(spec: DtoSpec, style: NamingStyle = "i-prefix"): string {
  return spec.interfaces.map((i) => renderInterface(i, style)).join("\n\n") + "\n";
}

/**
 * 被引用但没在这份 spec 里定义的类型名（如 ResponseStatusType）。
 *
 * 在真实仓库里这些类型是 import 进来的，这里没有 import，
 * 所以编译时一定报 "Cannot find name"。把它们单独摘出来告诉 verify，
 * 免得这类「不是错的错」淹掉真正的问题。
 *
 * 返回的名字已经套过命名风格，跟渲染出来的代码里的写法一致。
 */
export function externalTypes(spec: DtoSpec, style: NamingStyle = "i-prefix"): string[] {
  const defined = new Set(spec.interfaces.map((i) => interfaceName(i.name, style)));
  const referenced = spec.interfaces
    .flatMap((i) => i.fields)
    .filter((f) => f.isReference)
    .map((f) => interfaceName(f.type, style));
  return [...new Set(referenced.filter((t) => !defined.has(t)))];
}
