/**
 * 独立的编译检查入口，检查已经生成好的文件。
 *
 * 跑：npm run verify -- out/city.ts
 *     npm run verify -- fixtures/queryCityInfo.expected.ts
 *
 * 和 npm start 里那次检查的区别：start 有 spec 在手，能算出哪些是外部类型；
 * 这里只有一个文件，所以靠 verify 的分类 —— "Cannot find name" 一律当外部类型放过。
 * 宽松一点是故意的，这个入口用来事后复查，不是把关。
 */
import fs from "node:fs/promises";
import { verify, formatIssues } from "./src/verify.js";

const files = process.argv.slice(2).filter((a) => !a.startsWith("-"));

if (files.length === 0) {
  console.error(`用法: npm run verify -- <文件路径> [更多文件...]`);
  process.exit(1);
}

let failed = 0;

for (const file of files) {
  const code = await fs.readFile(file, "utf8");
  const { ok, issues } = verify(code);
  const missing = issues.filter((i) => i.kind === "missing-type");
  const real = issues.filter((i) => i.kind !== "missing-type");

  if (ok) {
    console.log(`\x1b[32m✓\x1b[0m ${file}`);
  } else {
    failed++;
    console.log(`\x1b[31m✗\x1b[0m ${file} —— ${real.length} 个问题`);
    console.log(formatIssues(real));
  }

  if (missing.length > 0) {
    const names = [...new Set(missing.map((i) => i.typeName).filter(Boolean))];
    console.log(`\x1b[90m  外部类型（已跳过）：${names.join(", ")}\x1b[0m`);
  }
}

process.exit(failed > 0 ? 1 : 0);
