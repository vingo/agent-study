# queryFlightPrice

查询航班价格。这份是四个 case 里最长的，用来测「写到后面容易草率收尾」那条 ——
最后一个 interface 的字段最多，看它会不会漏。

## 请求 QueryFlightPriceRequestType

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| depCity | String | 是 | 出发城市三字码 |
| arrCity | String | 是 | 到达城市三字码 |
| depDate | Date | 是 | 出发日期 |
| returnDate | Date | 否 | 返程日期，往返才传 |
| tripType | Integer | 是 | 行程类型 1 单程 2 往返 |
| passengers | List&lt;PassengerCount&gt; | 是 | 乘客数量 |
| cabinClass | String | 否 | 舱等 Y/C/F |

## PassengerCount

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| type | Integer | 是 | 1 成人 2 儿童 3 婴儿 |
| count | Integer | 是 | 人数 |

## 响应 QueryFlightPriceResponseType

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| ResponseStatus | ResponseStatusType | 否 | |
| flights | List&lt;FlightPrice&gt; | 否 | 航班价格列表 |
| lowestPrice | BigDecimal | 否 | 最低价 |
| currency | String | 否 | 币种 |

## FlightPrice

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| flightNo | String | 否 | 航班号 |
| airlineCode | String | 否 | 航司二字码 |
| airlineName | String | 否 | 航司名称 |
| aircraftType | String | 否 | 机型 |
| depAirport | String | 否 | 出发机场 |
| arrAirport | String | 否 | 到达机场 |
| depTerminal | String | 否 | 出发航站楼 |
| arrTerminal | String | 否 | 到达航站楼 |
| depTime | DateTime | 否 | 起飞时间 |
| arrTime | DateTime | 否 | 落地时间 |
| duration | Integer | 否 | 飞行时长，分钟 |
| stopCount | Integer | 否 | 经停次数 |
| adultPrice | BigDecimal | 否 | 成人价 |
| childPrice | BigDecimal | 否 | 儿童价 |
| tax | BigDecimal | 否 | 税费 |
| seatCount | Integer | 否 | 余座 |
| isCodeShare | Boolean | 否 | 是否共享航班 |
| mealType | String | 否 | 餐食类型 |
