# searchHotelList

搜索酒店列表。带必填字段和嵌套请求体，比 queryCityInfo 复杂一档。

## 请求 SearchHotelListRequestType

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| cityId | Integer | 是 | 城市 ID |
| checkIn | Date | 是 | 入住日期 yyyy-MM-dd |
| checkOut | Date | 是 | 离店日期 yyyy-MM-dd |
| pageIndex | Integer | 否 | 页码，从 1 开始 |
| pageSize | Integer | 否 | 每页条数，默认 20 |
| filter | HotelFilter | 否 | 筛选条件 |
| sortBy | String | 否 | 排序字段 price / distance / score |

## HotelFilter

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| priceMin | BigDecimal | 否 | 最低价 |
| priceMax | BigDecimal | 否 | 最高价 |
| starLevels | List&lt;Integer&gt; | 否 | 星级，可多选 |
| amenities | List&lt;String&gt; | 否 | 设施编码 |
| hasBreakfast | Boolean | 否 | 是否含早 |

## 响应 SearchHotelListResponseType

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| ResponseStatus | ResponseStatusType | 否 | |
| total | Integer | 否 | 总条数 |
| hotels | List&lt;HotelBrief&gt; | 否 | 酒店列表 |

## HotelBrief

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| hotelId | Long | 否 | 酒店 ID |
| hotelName | String | 否 | 酒店名 |
| starLevel | Integer | 否 | 星级 |
| lowestPrice | BigDecimal | 否 | 最低价 |
| score | Double | 否 | 评分 |
| commentCount | Integer | 否 | 点评数 |
| distanceToCenter | Double | 否 | 距市中心距离，单位公里 |
| tags | List&lt;String&gt; | 否 | 标签 |
