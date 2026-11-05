# queryDistrictList

查询行政区列表。属于 geoQueryService。

## 请求 QueryDistrictListRequestType

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| cityId | Integer | 是 | cityId |
| locale | String | 否 | 语言 |

## 响应 QueryDistrictListResponseType

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| ResponseStatus | ResponseStatusType | 否 | |
| districts | List&lt;DistrictInfo&gt; | 否 | |

## DistrictInfo

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| districtId | Integer | 否 | districtId |
| districtCnName | String | 否 | 中文名 |
| districtEnName | String | 否 | 英文名 |
| cityId | Integer | 否 | 所属城市 |
