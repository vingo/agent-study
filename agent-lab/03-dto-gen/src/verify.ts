/**
 * 编译门禁 —— 把生成的代码交给 TypeScript 编译器，看它是不是合法 TS。
 *
 * 为什么需要这一层：zod 只能保证「形状对」，保证不了「语义对」。
 * schema 校验通过、代码也渲染出来了，但产物可能根本编译不过。至少两类：
 *   · 同名字段重复 —— 文档里出现两行 glon，模型忠实照抄，TS 报 duplicate
 *   · 引用了不存在的类型 —— 少一个 import
 * 靠肉眼 diff 能发现一次，20 个 case 就看不动了。
 *
 * 这是 v4 那套 eval 断言里最粗、也最值钱的一条：「能编译」。
 * 现在先单独接上，等攒够 case 再把它折进通过率。
 *
 * 实现上用 compiler API 而不是起 tsc 子进程：不落临时文件，
 * 而且报错的行号直接对应生成的代码，不用做偏移换算。
 */
import path from "node:path";
import ts from "typescript";

const VIRTUAL_FILE = "__generated__.ts";
const EXTERNALS_FILE = "__externals__.d.ts";

/**
 * 真正加载 TypeScript 的标准库。
 *
 * 一开始图省事开了 noLib（生成的 DTO 只用 string/number/boolean，用不着标准库），
 * 但那样 Record<string, unknown>、Date 这类合法写法会报 "Cannot find name"，
 * 被归到 missing-type 里悄悄放过 —— 门禁形同虚设。
 * 宁可多花一百来毫秒读 lib，换一个不说谎的结果。
 */
const libCache = new Map<string, ts.SourceFile>();

function loadLib(fileName: string): ts.SourceFile | undefined {
  const cached = libCache.get(fileName);
  if (cached) return cached;

  const libDir = path.dirname(ts.sys.getExecutingFilePath());
  const full = path.join(libDir, fileName);
  const text = ts.sys.readFile(full);
  if (text === undefined) return undefined;

  const sf = ts.createSourceFile(fileName, text, ts.ScriptTarget.ES2022, true);
  libCache.set(fileName, sf);
  return sf;
}

/**
 * 问题分类。分开是因为处理方式完全不同：
 *   duplicate / other —— 真错，产物不可用，要么改 prompt 要么改文档
 *   missing-type      —— 引用了外部类型（ResponseStatusType 这种）。
 *                        在真实仓库里它有 import，这里没有，所以不算模型的错。
 *                        单独列出来，让调用方决定要不要当失败。
 */
export type IssueKind = "duplicate" | "missing-type" | "other";

export interface VerifyIssue {
  line: number;
  column: number;
  code: number;
  message: string;
  kind: IssueKind;
  /** missing-type 时是缺失的类型名，方便直接拿去补 externals */
  typeName?: string;
}

export interface VerifyResult {
  /** 没有 duplicate / other 类问题。missing-type 不影响 ok */
  ok: boolean;
  issues: VerifyIssue[];
}

export interface VerifyOptions {
  /**
   * 已知的外部类型名。声明进来就不会报 missing-type，
   * 相当于告诉编译器「这个类型在真实仓库里存在，别管它」。
   */
  externals?: string[];
}

/**
 * TS 错误码 → 我们关心的分类。
 * 2300 Duplicate identifier
 * 2717 Subsequent property declarations must have the same type（重复字段的连带错）
 * 2304 Cannot find name / 2552 Cannot find name, did you mean
 */
function classify(code: number, message: string): { kind: IssueKind; typeName?: string } {
  if (code === 2300 || code === 2717) return { kind: "duplicate" };
  if (code === 2304 || code === 2552) {
    // 从 "Cannot find name 'ResponseStatusType'." 里把类型名抠出来
    const m = message.match(/'([^']+)'/);
    return { kind: "missing-type", typeName: m?.[1] };
  }
  return { kind: "other" };
}

/** 把外部类型伪造成 d.ts，让编译器认识它们 */
function externalsDts(names: string[]): string {
  return names.map((n) => `declare type ${n} = unknown;`).join("\n") + "\n";
}

export function verify(code: string, options: VerifyOptions = {}): VerifyResult {
  const externals = options.externals ?? [];
  const files = new Map<string, string>([[VIRTUAL_FILE, code]]);
  if (externals.length > 0) files.set(EXTERNALS_FILE, externalsDts(externals));

  const sources = new Map<string, ts.SourceFile>();
  for (const [name, text] of files) {
    sources.set(name, ts.createSourceFile(name, text, ts.ScriptTarget.ES2022, true));
  }

  const compilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    lib: ["lib.es2022.d.ts"],
    skipLibCheck: true,
    // 不去解析 import —— 生成的文件里没有 import，
    // 外部类型走 externals 那条路伪造声明
    noResolve: true,
  };

  const defaultLib = "lib.es2022.d.ts";

  // CompilerHost：内存里那几个文件 + 磁盘上的标准库
  const host: ts.CompilerHost = {
    getSourceFile: (name) => sources.get(name) ?? loadLib(name),
    getDefaultLibFileName: () => defaultLib,
    writeFile: () => {},
    getCurrentDirectory: () => "",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => files.has(name) || loadLib(name) !== undefined,
    readFile: (name) => files.get(name),
  };

  const program = ts.createProgram([...files.keys()], compilerOptions, host);
  const generated = program.getSourceFile(VIRTUAL_FILE)!;

  const diagnostics = [
    ...program.getSyntacticDiagnostics(generated),
    ...program.getSemanticDiagnostics(generated),
  ];

  const issues: VerifyIssue[] = diagnostics.map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, " ");
    const pos =
      d.file && d.start !== undefined
        ? d.file.getLineAndCharacterOfPosition(d.start)
        : { line: 0, character: 0 };
    return {
      line: pos.line + 1,
      column: pos.character + 1,
      code: d.code,
      message,
      ...classify(d.code, message),
    };
  });

  return {
    ok: issues.every((i) => i.kind === "missing-type"),
    issues,
  };
}

/** 终端里打出来的形状，index.ts 用 */
export function formatIssues(issues: VerifyIssue[]): string {
  return issues
    .map((i) => `  ${i.line}:${i.column}  ${i.message} \x1b[90m(TS${i.code})\x1b[0m`)
    .join("\n");
}
