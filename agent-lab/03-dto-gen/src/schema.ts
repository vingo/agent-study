/**
 * 阶段 2 · v1 —— 结构化输出的 schema。
 *
 * 跟阶段 0/1 的关键区别：
 *   阶段 0/1  模型返回自由文本，你自己读
 *   现在      模型返回【结构化数据】，代码直接消费
 *
 * 这份 schema 有两个身份，同一份定义两处用：
 *   1. 转成 JSON Schema 塞给模型（generate.ts 里的 z.toJSONSchema），约束输出形状
 *   2. 运行时校验模型的输出，不合法就带着错误信息让它重试
 *
 * 第 2 点是重点，也是你 BFF 的老本行 —— 永远不要假设外部输入合法，
 * 模型的输出就是一种外部输入。
 *
 * 每个 .describe() 都会进 JSON Schema，变成模型看到的 prompt 的一部分。
 * 所以这里的描述和 MCP 工具的 description 是同一件事：写清楚能少一半重试。
 */
import { z } from "zod";

/**
 * TS 基础类型的白名单。
 *
 * 为什么用枚举而不是 z.string()：文档里的类型名是 Java/SOA 味的
 * （Integer、Long、List<String>、Map<String,Object>），模型会习惯性照搬。
 * 枚举能让这类错误在校验阶段就被挡住并触发重试，而不是悄悄写进生成的文件。
 *
 * 代价是引用其他 interface 时类型名是自由的（CityInfo、ResponseStatusType），
 * 装不进枚举 —— 所以下面用 isReference 分流，引用类型走 z.string()。
 */
const primitiveType = z.enum(["string", "number", "boolean", "unknown", "any"]);

const fieldSchema = z.object({
  name: z
    .string()
    .regex(/^[a-zA-Z_$][a-zA-Z0-9_$]*$/, "字段名必须是合法的 JS 标识符")
    .describe("字段名，保持文档里的原样，不要改大小写"),

  type: z
    .string()
    .describe(
      "TS 类型。基础类型只能是 string / number / boolean / unknown / any 之一：" +
        "Integer、Long、Short、Double、Float、BigDecimal 都是 number；" +
        "String、Date、DateTime 都是 string；Boolean 是 boolean。" +
        "如果是引用另一个 interface（如 CityInfo），写它的名字并把 isReference 设为 true。",
    ),

  isArray: z
    .boolean()
    .default(false)
    .describe("是否数组。List<Integer> 是 type=number + isArray=true，不要写成 number[]"),

  isReference: z
    .boolean()
    .default(false)
    .describe(
      "type 是否引用了另一个 interface。引用类型必须在同一次输出的 interfaces 里定义，" +
        "或是外部已存在的类型（如 ResponseStatusType）。",
    ),

  required: z
    .boolean()
    .default(false)
    .describe("是否必填。文档没明确说必填就填 false —— 这个仓库里绝大多数字段是可选的"),

  description: z
    .string()
    .optional()
    .describe("字段注释，照抄文档里的说明。文档没写就留空，不要自己编"),
});

const interfaceSchema = z.object({
  name: z
    .string()
    .regex(/^I?[A-Z][a-zA-Z0-9]*$/, "interface 名必须是大驼峰，可选 I 前缀")
    .describe(
      "interface 名，保持文档里的原样。请求体用 XxxRequestType，响应体用 XxxResponseType，" +
        "嵌套结构用它自己的名字（如 CityInfo）。I 前缀由渲染层统一处理，这里写不写都行。",
    ),

  description: z.string().optional().describe("interface 上方的块注释，文档没写就留空"),

  fields: z.array(fieldSchema).describe("字段列表，顺序保持和文档一致"),
});

export const dtoSchema = z.object({
  interfaces: z
    .array(interfaceSchema)
    .min(1, "至少要有一个 interface")
    .describe(
      "文档里所有的 interface。嵌套对象要拆成独立的 interface 放进这个数组，" +
        "然后在引用它的字段上设 isReference=true —— 不要把嵌套结构内联展开。",
    ),

  /**
   * v3 加的。让模型报告它观察到的命名风格，而不是由调用方用 --style 指定。
   *
   * 为什么交给模型：同一个仓库里不同目录的约定可能不一样
   * （geoQueryService 不带 I 前缀，hotelBookService 带）。
   * 这种「局部约定」只能靠看邻居文件得知，写死在参数里就错了。
   *
   * 注意这是可选的。v1/v2 的调用方不传也能跑，行为不变 ——
   * 加字段不破坏已有调用方，跟 BFF 接口加字段是同一个道理。
   */
  namingStyle: z
    .enum(["plain", "i-prefix"])
    .optional()
    .describe(
      "目标目录里既有文件的 interface 命名风格。看到 `export interface IFoo` 填 i-prefix，" +
        "看到 `export interface Foo` 填 plain。没有参考文件就不填。" +
        "看目标目录的邻居文件来判断，不要凭全局习惯猜。",
    ),
});

export type FieldSpec = z.infer<typeof fieldSchema>;
export type InterfaceSpec = z.infer<typeof interfaceSchema>;
export type DtoSpec = z.infer<typeof dtoSchema>;
