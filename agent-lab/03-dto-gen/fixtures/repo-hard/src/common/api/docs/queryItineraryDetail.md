# queryItineraryDetail

查询完整行程详情。这份文档很长，共 12 个 interface，嵌套三层。属于 legacyService。

## 请求 QueryItineraryDetailRequestType

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| itineraryId | Long | 是 | 行程 ID |
| locale | String | 否 | 语言 |
| includeFlights | Boolean | 否 | 是否含机票 |
| includeHotels | Boolean | 否 | 是否含酒店 |

## 响应 QueryItineraryDetailResponseType

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| ResponseStatus | ResponseStatusType | 否 |  |
| itinerary | ItineraryInfo | 否 | 行程主体 |
| traveler | TravelerInfo | 否 | 出行人 |
| payment | PaymentInfo | 否 | 支付信息 |

## ItineraryInfo

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| itineraryId | Long | 否 | 行程 ID |
| title | String | 否 | 行程标题 |
| startDate | Date | 否 | 开始日期 |
| endDate | Date | 否 | 结束日期 |
| segments | List<SegmentInfo> | 否 | 行程段 |
| totalAmount | BigDecimal | 否 | 总金额 |
| status | Integer | 否 | 状态 |

## SegmentInfo

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| segmentId | Long | 否 | 段 ID |
| type | Integer | 否 | 1 机票 2 酒店 3 用车 |
| flight | FlightSegment | 否 | 机票段详情 |
| hotel | HotelSegment | 否 | 酒店段详情 |
| sortIndex | Integer | 否 | 排序 |

## FlightSegment

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| flightNo | String | 否 | 航班号 |
| depTime | DateTime | 否 | 起飞时间 |
| arrTime | DateTime | 否 | 落地时间 |
| cabin | String | 否 | 舱位 |
| passengers | List<PassengerRef> | 否 | 乘客引用 |

## HotelSegment

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| hotelId | Long | 否 | 酒店 ID |
| hotelName | String | 否 | 酒店名 |
| checkIn | Date | 否 | 入住 |
| checkOut | Date | 否 | 离店 |
| rooms | List<RoomRef> | 否 | 房间引用 |

## PassengerRef

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| passengerId | Long | 否 | 乘客 ID |
| ticketNo | String | 否 | 票号 |

## RoomRef

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| roomId | Long | 否 | 房型 ID |
| guestName | String | 否 | 入住人 |

## TravelerInfo

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| uid | Long | 否 | 用户 ID |
| Name | String | 否 | 姓名，注意首字母大写 |
| mobile | String | 否 | 手机号 |
| contacts | List<ContactRef> | 否 | 联系人 |

## ContactRef

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| contactId | Long | 否 | 联系人 ID |
| relation | String | 否 | 关系 |

## PaymentInfo

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| payOrderId | Long | 否 | 支付单号 |
| payAmount | BigDecimal | 否 | 支付金额 |
| payMethod | Integer | 否 | 支付方式 |
| payTime | DateTime | 否 | 支付时间 |
| invoice | InvoiceInfo | 否 | 发票信息 |

## InvoiceInfo

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| invoiceId | Long | 否 | 发票 ID |
| invoiceType | Integer | 否 | 发票类型 |
| taxNo | String | 否 | 税号 |
| title_name | String | 否 | 发票抬头，注意下划线命名 |
