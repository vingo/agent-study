# createOrder

创建订单。这份文档故意留了几处坑，用来测「拿不准就保守」和「照抄不要修正」：
Map 类型、说明栏空着、命名风格不统一、字段名带下划线。

## 请求 CreateOrderRequestType

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| hotelId | Long | 是 | 酒店 ID |
| roomId | Long | 是 | 房型 ID |
| checkIn | Date | 是 | |
| checkOut | Date | 是 | |
| guests | List&lt;Guest&gt; | 是 | 入住人 |
| contact | ContactInfo | 是 | 联系人 |
| extInfo | Map&lt;String,Object&gt; | 否 | 扩展字段，透传给下游 |
| remark | String | 否 | 备注 |

## Guest

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| name | String | 是 | 姓名 |
| idType | Integer | 否 | 证件类型 |
| idNo | String | 否 | 证件号 |
| birth_day | String | 否 | 出生日期，注意这个字段是下划线命名 |

## ContactInfo

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| Name | String | 是 | 联系人姓名，注意首字母大写 |
| mobile | String | 是 | 手机号 |
| email | String | 否 | |

## 响应 CreateOrderResponseType

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| ResponseStatus | ResponseStatusType | 否 | |
| orderId | Long | 否 | 订单号 |
| needPay | Boolean | 否 | 是否需要支付 |
| payDeadline | DateTime | 否 | 支付截止时间 |
