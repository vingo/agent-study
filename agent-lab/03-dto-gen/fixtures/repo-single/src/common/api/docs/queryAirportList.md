# queryAirportList

查询机场列表。属于 flightSearchService。

## 请求 QueryAirportListRequestType

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| cityCode | String | 是 | 城市三字码 |
| locale | String | 否 | 语言 |

## 响应 QueryAirportListResponseType

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| ResponseStatus | ResponseStatusType | 否 | |
| airports | List&lt;AirportInfo&gt; | 否 | |

## AirportInfo

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| airportCode | String | 否 | 三字码 |
| airportCnName | String | 否 | 中文名 |
| airportEnName | String | 否 | 英文名 |
| terminalCount | Integer | 否 | 航站楼数量 |
