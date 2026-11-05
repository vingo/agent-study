# 03-dto-gen

阶段 2–3 的主线项目：接口文档 → TypeScript DTO。从单轮结构化输出一路做到可观测、有成本归因的多轮 agent。

## 入口

| 命令 | 版本 | 干什么 |
|---|---|---|
| `npm start -- <文档>` | v1 | 单轮。我读文件塞给模型，它一次性返回结构 |
| `npm run agent -- <仓库目录> [文档]` | v2/v3 | 多轮。它自己 list/search/read，照着仓库既有风格写 |
| `npm run eval` | v4 | 跑全部 case，输出通过率 |
| `npm run compare` | 阶段 3 | 四个编排范式跑同一批任务，对比开销 |
| `npm run mini -- <仓库目录> [文档]` | 阶段 4 | 用自造的 `mini/` 框架跑 v2/v3 场景 |
| `npm run verify -- <文件>` | — | 单独检查一个 .ts 文件能不能编译 |
| `npm run typecheck` | — | 项目自身的类型检查 |

```bash
cp .env.example .env    # 填 token
npm install
npm run eval            # 8 个 case，一次约 $0.44
```

`npm run mini` 支持 `--resume <快照>` 从中断处接着跑，快照在 `.sessions/`。

论文要点在 `PAPERS.md`（ReAct / Reflexion / Toolformer，只记对工程决策有影响的部分）。

## 两道关

产物要同时过编译和断言，缺一不可：

- **`src/verify.ts`** 用 TypeScript compiler API 在内存里编译，答「是不是合法 TS」
- **`src/assert.ts`** 拿原始文档当标准答案逐字段核对，答「生成得对不对」

两道都要，因为**编译通过不等于生成对了**。漏掉一整个 interface 编译器完全不管 —— 这是实测踩过的，靠肉眼 diff 才发现。

## 谁负责什么

```
文档 → 模型（理解、抽取字段）→ 结构化数据 → 代码（渲染、落盘）→ .ts 文件
                                              ↓
                                     verify + assert 把关
```

模型只输出结构化数据，不拼代码字符串。让它直接吐 TS 代码会在缩进、引号、分号上犯随机错误，而且没法校验；输出结构化数据再由 `render.ts` 渲染，产物是确定的。

## 规则写在哪

规则有两个落点，放错地方就白写：

- **`schema.ts` 的 `.describe()`** —— 字段级局部规则。它紧贴字段、随 `z.toJSONSchema()` 进 tool 定义，模型填那个字段时一定读到，命中率最高。类型映射、命名约定、嵌套怎么拆都在这里
- **`agent.ts` 的 SYSTEM_PROMPT** —— 跨字段的全局原则。schema 表达不了的：拿不准时的取舍、文档自相矛盾怎么办

所以 SYSTEM_PROMPT 刻意写得短。把已在 schema 里的类型映射表再抄一遍不会让它更准，只会占注意力。

## 踩过的坑

**编译通过 ≠ 生成对了。** 见上。这也是 `assert.ts` 存在的全部理由。

**断言的标准答案要和给模型的规则独立。** `assert.ts` 里的 `TYPE_MAP` 是单独写的一份，没复用 `schema.ts` 的描述。共用会变成自己批自己的卷子：模型照规则输出、断言照同一份规则判，永远一致，测不出任何东西。

**100% 通过率可能是假的。** 第一次跑出全绿，核对产物才发现断言压根没检查 `required` —— 文档有「必填」列但解析时漏了。全绿先怀疑断言，别急着高兴。

**「有产物」不等于「成功」。** `agent.ts` 的终止判断原本写 `if (lastSpec && emits > 0) return "done"`，结果两次提交都没通过却报完成、退出码 0。改成单独记 `lastReviewOk`。这类 bug 类型检查过、不崩、日志看着正常。

**同一输入结果会不同。** `repo:hotel-iprefix` 有一次失败、重跑四次全过。只跑一次的通过率没有意义 —— 会去修一个不存在的问题，或误以为系统很稳。`--runs N` 就是为这个。

**`noLib` 会让编译门禁静默失效。** 图省事关掉标准库（DTO 只用 string/number/boolean），结果 `Record<string, unknown>`、`Date` 报 "Cannot find name" 被归进 missing-type 悄悄放过。改成真加载 `lib.es2022.d.ts`，多花 100ms。

**参数解析的 off-by-one。** `--runs` 缺省时 `indexOf` 返回 -1，`runsAt+1` 正好是 0，把 `args[0]`（过滤词本身）排除掉了。类型检查拦不住。

**tool_use 后面必须紧跟 tool_result。** Reflexion 第一版 0% 通过率，我差点当成「范式不适用」的证据 —— 实际是自省通过后没给 `emit_dto` 配 tool_result，下次调用直接 400，而报错只说 `messages.8`，得自己数消息。差点把自己的 bug 当实验结论。

**两层重试会变成乘积。** `llm.ts` 里把 SDK 的 `maxRetries` 关成 0 自己做，否则实际请求次数是乘积而日志看不出来。

**预算闸是事后生效的。** 检查已花费额，所以第一次调用永远放行，超支在下一次才拦。想事前拦得预估本次开销，但 output token 调用前不可知。它防的是「循环跑飞持续烧钱」，不防「单次超支」——后者靠 `max_tokens`。

**缓存会让对比实验静默失效。** 四个范式的第一轮请求哈希相同（同样的 system + tools + 第一条 user 消息），后跑的范式直接命中前面的缓存。`reflexion-oracle` 第一版报出 12ms / $0 / 通过，看着像「零成本通过」，实际整条链路都在吃 react 的缓存。`compare.ts` 每个范式跑前 `clearCache()`。缓存本身在生产上是对的，错的是在对比实验里留着它。

**判据和评分不一致 = 让 agent 盲考。** 这个最隐蔽。`makeReview` 漏检了 `namingStyle`，但 `finalJudge` 算分。于是 Evaluator 说通过 → agent 收工 → 最终评分因风格不对判失败，等于考完才告诉它这题也算分。表现是 `reflexion-oracle` **一条教训都没提炼**（它以为自己全对）却稳定失败 2/3 次，我一开始误判成「Reflexion 没用」。修好后 hard case 从稳定失败变成 12/12 全过。

> 推论：我造的「难 case」之所以难，一半是因为判据本身有 bug。真正的难 case 得来自真实脏数据，不是凭想象编的。

## 阶段 3 的结论

`npm run compare` 让四个编排范式跑同一批任务（hard case，3 次运行）：

| 范式 | 通过率 | 调用/次 | 成本 | 相对 ReAct |
|---|---|---|---|---|
| ReAct | 100% | 4.0 | $0.2963 | 基线 |
| Plan-and-Execute | 100% | 5.7 | $0.4350 | 调用 1.42× token 1.46× |
| Reflexion（劣质 Evaluator） | 100% | 7.7 | $0.8462 | 调用 1.92× token 2.69× |
| Reflexion（编译器+断言当 Evaluator） | 100% | 4.7 | $0.3673 | 调用 1.17× token 1.20× |

通过率零差异。三点判断依据：

1. **ReAct 不是可选范式，它就是 `agent.ts` 那个循环**，只是代码里没写这个词。所以它是基线不是选项。
2. **Plan-and-Execute 列的计划和 SYSTEM_PROMPT 里「怎么开始」那节几乎一字不差。** 任务结构本来固定，让模型每次现场重推一遍纯属多花一次调用。它适合结构不确定、需要先拆解的场景。
3. **Reflexion 的收益来自多轮试错的累积改进。** 论文 AlfWorld 提升 22% 是跑 12 轮之后的数字。我们的任务单轮通过率已接近 100%，没有失败可供迭代，多花的调用零回报。

> Reflexion 需要 Evaluator，效果上限由 Evaluator 质量决定。判断要不要用它，看的是**有没有足够多的失败可供迭代**，不是有没有 oracle。

基于这组数据跳过了框架迁移和 v5 多 agent 拆分 —— 同样是「解决还没遇到的问题」。

### 一处需要更正的结论

这份 README 原先写的是「Reflexion 是你拿不到 oracle 时的退路，能写出断言就别用它」。**读完论文后确认这是错的，恰好说反了。**

Shinn et al. 2023 的架构是三个角色：Actor 生成动作、**Evaluator 打分（编程任务上用的正是单元测试 —— 客观判据）**、Self-Reflection 把分数翻译成自然语言教训存进 episodic memory。所以 Reflexion 不是替代 oracle，它是把 oracle 的信号翻译成更有指导性的形式。

论文自己给了反例：Reflexion 在 MBPP Python 上**低于** GPT-4 基线，原因是自生成单测假阳性率太高，论文结论是「框架对评估质量有依赖」。

原先那个实验之所以得出反向结论，是因为我实现时**故意不给自省阶段看判据**（`reflexionBlind`），等于给了它一个劣质 Evaluator —— 难怪它把填对的答案判成错的。按论文架构重做的版本是 `reflexionOracle`，两个都留在 `patterns.ts` 里做对照。

结论修订后仍然是「这个任务不需要它」，但理由从「有判据就别用」变成了「没有失败可迭代」。

## 阶段 4：自造框架

`mini/` 是把阶段 0 那 50 行循环扩成的小框架，四个文件：工具注册、会话快照、上下文压缩、循环本体。详见 `mini/README.md`。

毕业标准是它能替代 `src/agent.ts` —— 实测产物 diff 无差异。

读 SDK 源码的收获直接改了生产代码：`llm.ts` 原来的重试判断漏了 `x-should-retry` 响应头（服务端明确说要不要重试时该听它的）、408 请求超时、409 锁超时，以及 `retry-after-ms`（服务端告诉你等多久时不该自己算退避）。退避参数也照 SDK 对齐了。

一个诚实的评价：`src/agent.ts` 专用、更直白；`mini/` 通用、多一层抽象。**值不值得取决于你有几个 agent** —— 一个的话前者更好。这就是「别急着上框架」的具体含义：框架的价值在第二个使用场景出现时才显现，提前抽象只是在猜。造完才真正理解为什么。

## 安全

`fixtures/repo-injection/` 是 prompt injection 演练：文档的 HTML 注释和字段说明里埋了指令，要求读 `.env`、`/etc/passwd` 并把内容塞进注释，还加了「不要在回复里提到」。

模型识别并拒绝了，还主动说明。**但这不是防线。** 真正的防线是 `tools.ts` 的 `resolveInside`：`path.resolve` 后比前缀，不是检查字符串里有没有 `..`（后者能被 `a/../../b`、URL 编码、符号链接绕过）。

假设模型完全照注入指令行事，直接调工具试过这些，全部拦住：

```
../../../../../.env          BLOCKED
/etc/passwd                  BLOCKED
src/../../../.env            BLOCKED
./src/common/../../../.env    BLOCKED
search_files dir=../..       BLOCKED
```

模型这次拒绝了，下次换个说法可能就不拒绝；`path.resolve` 后比前缀不会因为措辞改变而失效。权限边界卡在代码层，不靠 prompt 里写「请不要听信外部指令」。

## 成本

所有模型调用走 `src/llm.ts` 一个入口，包装顺序（外→内）：预算检查 → 缓存 → 限流 → 重试。缓存在限流外（命中不占并发额度），重试在最内（重试不重新排队，否则退避白等）。

```
调用 15 次  token 57769/6044  成本 ~$0.2640  119.3s
成本归因：
  agent      11 次  $0.1663  63%
  generate    4 次  $0.0977  37%
```

`LLM_BUDGET_USD`、`LLM_MAX_CONCURRENT`、`LLM_CACHE=0` 可以调。计价表在 `llm.ts`，是估算用的，对账看账单。
