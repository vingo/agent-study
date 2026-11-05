# refundOrder

订单退款。属于 hotelBookService。

## 请求 RefundOrderRequestType

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| orderId | Long | 是 | 订单号 |
| refundAmount | BigDecimal | 是 | 退款金额 |
| reason | String | 否 | 退款原因 |

## 响应 RefundOrderResponseType

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| ResponseStatus | ResponseStatusType | 否 | |
| refundId | Long | 否 | 退款单号 |
| status | Integer | 否 | 退款状态 |
