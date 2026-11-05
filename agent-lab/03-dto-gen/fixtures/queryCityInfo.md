# queryCityInfo

查询城市信息。

## 请求 QueryCityInfoRequestType

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| token | String | 否 | token |
| cityIds | List&lt;Integer&gt; | 否 | cityId |
| locale | String | 否 | 语言 具体类型请参考 语言code定义标准：http://conf.ctripcorp.com/pages/viewpage.action?pageId=153976937 |

## 响应 QueryCityInfoResponseType

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| ResponseStatus | ResponseStatusType | 否 | |
| cityInfos | List&lt;CityInfo&gt; | 否 | |
| userInfos | List&lt;UserInfo&gt; | 否 | |


## CityInfo

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| cityId | Integer | 否 | cityId |
| provinceId | Integer | 否 | provinceId |
| countryId | Integer | 否 | countryId |
| cityCnName | String | 否 | 中文名 |
| cityEnName | String | 否 | 英文名 |
| pinyin | String | 否 | 拼音字段 |
| jianpin | String | 否 | 简拼 |
| code | String | 否 | 地区 ISO 或其他标准编码 |
| glat | Double | 否 | 纬度；国内高德，海外谷歌 |
| glon | Double | 否 | 经度;国内高德,海外谷歌 |

## UserInfo

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| uid | Integer | 否 | uid |
| name | String | 否 | 名称 |
| alias | Array<String> | 否 | 别名 |

