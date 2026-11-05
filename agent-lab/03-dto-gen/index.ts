/**
 * CLI 入口。
 *
 * 跑：npm start -- fixtures/queryCityInfo.md
 *     npm start -- fixtures/queryCityInfo.md --style plain
 *     npm start -- fixtures/queryCityInfo.md -o out/queryCityInfo.interface.ts
 */
import fs from "node:fs/promises";
import path from "node:path";
import { generate } from "./src/generate.js";
import { render, externalTypes, type NamingStyle } from "./src/render.js";
import { verify, formatIssues } from "./src/verify.js";
import { assertSpec, formatViolations } from "./src/assert.js";

const args = process.argv.slice(2);
const docPath = args.find((a) => !a.startsWith("-"));
const styleArg = args[args.indexOf("--style") + 1];
const outArg = args.includes("-o") ? args[args.indexOf("-o") + 1] : undefined;

if (!docPath) {
  console.error(`
用法: npm start -- <接口文档路径> [选项]

选项:
  --style <plain|i-prefix>   命名风格，默认 i-prefix
                             （你们仓库两种混用，所以做成可选）
  -o <输出路径>               写入文件，不给就打印到终端

例子:
  npm start -- fixtures/queryCityInfo.md
  npm start -- fixtures/queryCityInfo.md --style plain -o out/city.interface.ts
`);
  process.exit(1);
}

const style: NamingStyle = styleArg === "plain" ? "plain" : "i-prefix";
const doc = await fs.readFile(docPath, "utf8");

console.error(`\x1b[90m解析 ${docPath}（${doc.length} 字符，命名风格 ${style}）…\x1b[0m`);

const { spec, attempts, failures } = await generate(doc);

// 把重试情况打出来 —— 观察模型常犯什么错，是改 prompt 的依据
if (attempts > 1) {
  console.error(`\x1b[33m重试了 ${attempts - 1} 次\x1b[0m`);
  failures.forEach((f, i) => console.error(`\x1b[90m第 ${i + 1} 次失败:\n${f}\x1b[0m`));
}

const code = render(spec, style);
const count = spec.interfaces.length;
const fields = spec.interfaces.reduce((n, i) => n + i.fields.length, 0);

// 编译门禁：schema 校验只保证形状对，这一步才保证产物是合法 TS
const externals = externalTypes(spec, style);
const result = verify(code, { externals });

if (outArg) {
  await fs.mkdir(path.dirname(outArg), { recursive: true });
  await fs.writeFile(outArg, code, "utf8");
  console.error(`\x1b[32m✓\x1b[0m 写入 ${outArg}（${count} 个 interface，${fields} 个字段）`);
} else {
  console.log(code);
  console.error(`\x1b[32m✓\x1b[0m ${count} 个 interface，${fields} 个字段`);
}

if (externals.length > 0) {
  console.error(`\x1b[90m外部类型（真实仓库里靠 import 引入，已跳过检查）：${externals.join(", ")}\x1b[0m`);
}

let failed = false;

if (result.ok) {
  console.error(`\x1b[32m✓\x1b[0m 编译通过`);
} else {
  const real = result.issues.filter((i) => i.kind !== "missing-type");
  console.error(`\x1b[31m✗ 编译不通过，${real.length} 个问题\x1b[0m`);
  console.error(formatIssues(real));
  failed = true;
}

// 断言层：编译通过不代表生成对了。漏一整个 interface 编译器是不管的
const asserted = assertSpec(doc, spec);
const fails = asserted.violations.filter((v) => v.severity === "fail");
const warns = asserted.violations.filter((v) => v.severity === "warn");
const { docInterfaces, specInterfaces, docFields, specFields } = asserted.stats;

if (asserted.ok) {
  console.error(
    `\x1b[32m✓\x1b[0m 断言通过（文档 ${docInterfaces} interface / ${docFields} 字段，` +
      `产物 ${specInterfaces} / ${specFields}）`,
  );
} else {
  console.error(
    `\x1b[31m✗ 断言不通过，${fails.length} 个问题\x1b[0m` +
      `（文档 ${docInterfaces} interface / ${docFields} 字段，产物 ${specInterfaces} / ${specFields}）`,
  );
  console.error(formatViolations(fails));
  failed = true;
}

if (warns.length > 0) {
  console.error(`\x1b[33m${warns.length} 个警告\x1b[0m`);
  console.error(formatViolations(warns));
}

// 退出码非 0，这样以后能直接串进 CI 或 eval 脚本
if (failed) process.exit(1);
