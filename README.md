# agent-lab

Agent 工程 12 周学习计划的练习代码。每个目录是一个阶段，从零依赖手写循环开始，逐层往上加。

## 目录

| 目录 | 阶段 | 内容 |
|---|---|---|
| `agent-lab/00-bare-loop/` | 阶段 0 | 不用任何框架手写 agent 循环，脚手架给好，循环体自己填 |
| `agent-lab/01-recite/` | 阶段 0 毕业 | 关掉资料从空文件夹默写一遍同样的循环，100 行 |
| `agent-lab/02-mcp-slb/` | 阶段 1 | 把 `slb-app-query` skill 包成 MCP server，三个工具 |
| `agent-lab/03-dto-gen/` | 阶段 2–3 | 主线项目。接口文档 → TS DTO，从单轮结构化输出做到可观测多轮 agent |

## 跑起来

每个项目都要先配 `.env`：

```bash
cd agent-lab/00-bare-loop
cp .env.example .env    # 然后填入 token
npm install
npm run check           # 连通性自检
npm start
```

`02-mcp-slb` 额外有两个测试台，区别很重要：

```bash
npm run probe app 100014416      # 看 API 的原始响应
npm run call slb_app_info 100014416   # 看你的工具最终返回给模型什么
```

调措辞要看 `call` 的输出，那才是模型看到的内容。

`03-dto-gen` 是主线，六个入口，详见它自己的 README：

```bash
npm start -- fixtures/queryCityInfo.md          # v1 单轮
npm run agent -- fixtures/repo                   # v2/v3 多轮自主
npm run eval                                     # v4 通过率，一次约 $0.26
npm run compare                                  # 三个编排范式对比
```

## 踩过的坑

**`.env` 不生效** — `--env-file` 是补空不是覆盖，shell 里已有的同名变量优先。所有 npm script 都用 `env -u` 显式切断了继承链，因为 Claude Code 的 `/model` 命令会改写 `~/.zshrc` 里的 `ANTHROPIC_BASE_URL`。

**MCP SDK 报 TS2589「类型实例化过深」** — 根因是 `node_modules` 里有两份 zod（顶层一份、SDK 自带一份），同名不同源的类型对不上。诊断用 `npm ls zod --all`，看到非 deduped 的第二份即是。修复是把版本对齐并在 `package.json` 里锁死，不用 `^`。

**工具返回值必须实测** — 接口文档常与实况不符（`apps` 接口外面套了一层 `{total, apps:[]}`，文档里没写）。类型检查也拦不住语义错误：`filter` 条件写反、`join` 一个对象数组得到 `[object Object]`，两者都能编译通过且运行不崩，只有真跑一次才看得见。

## 三条核心经验

1. **agent 技术门槛低，难在工程化。** 核心就是 `while (模型还想调工具) { 调工具, 结果塞回去 }`。
2. **上下文的稀缺资源不是 token 额度，是模型的注意力。** 24 个字段挑 3 个，10 台机器报一行汇总。
3. **工具的返回值是给模型的下一步指令，不是数据搬运。** 「你传的是 http://，请改用 https:// 重试」能让模型自我纠正；返回一个 `-1` 它只能干瞪眼。

## 阶段 2–4 追加的经验

4. **测试通过不等于做对了。** 编译器说合法、断言说对齐，两者都绿也可能漏了整个 interface —— 断言本身可能压根没检查那一项。全绿先怀疑断言。
5. **规则要放在离决策点最近的地方。** 工具 schema 的 `.describe()` 比 SYSTEM_PROMPT 命中率高，因为模型填那个字段时一定读到。prompt 不止一处，写错落点等于没写。
6. **非确定性要靠多次运行才看得出。** 同一输入一次失败四次成功。跑一次的结论可能让你去修一个不存在的问题。
7. **复杂编排先证明必要性。** Plan-and-Execute 和 Reflexion 在主线任务上多花 20–170% 开销、通过率零提升。判断要不要用 Reflexion 看的是**有没有足够多的失败可供迭代**（它的收益来自多轮试错累积），不是有没有 oracle —— 论文里它的 Evaluator 用的正是单元测试。
8. **安全边界卡在代码层，不靠 prompt。** 模型这次拒绝了注入，下次换个说法可能就不拒绝；`path.resolve` 后比前缀不会因措辞改变而失效。
9. **看不见的成本控制不住。** 三处各自 `new Anthropic()` 时，「多跑几次看稳定性」这个建议是空话 —— 提建议的人不知道代价。
10. **判据的覆盖面决定 agent 的能力上限。** 判据漏检的维度，模型自省再多轮也发现不了；判据和最终评分不一致，等于让 agent 盲考。三篇论文（ReAct 23% 失败源于检索无用内容、Reflexion 在 MBPP 掉分因自生成单测假阳性、Toolformer 全部训练信号就是 perplexity）都在说同一件事。
11. **实验设施本身会骗你。** 缓存让四个范式吃同一份结果、判据漏检让难 case 假难。得出「范式不适用」「模型不行」这类结论前，先怀疑测量工具。
