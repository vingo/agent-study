// 这是 BFF 仓库里真实存在的文件（src/common/api/geoQueryService/interface/queryCityInfo.interface.ts）
// 用来跟生成结果对比。注意它用的是 plain 风格（没有 I 前缀）。
//
// 对比时看这几处最容易出错的地方：
//   · List<Integer> → number[]，不是 Integer[] 也不是 Array<number>
//   · Double → number
//   · ResponseStatusType 和 CityInfo 是引用，不该内联展开
//   · locale 那条注释里的长 URL，原文件里被折行了 —— 生成时不必模仿折行
//   · ResponseStatus 首字母大写（跟其他字段的小驼峰不一致），这是真实数据，别"修正"它

export interface QueryCityInfoRequestType {
    /**
     * token
     */
    token?: string
    /**
     * cityId
     */
    cityIds?: number[]
    /**
     * 语言 具体类型请参考 语言code定义标准：http://conf.ctripcorp.com/pages/viewpage.action?pageId=153976937
     */
    locale?: string
}

export interface QueryCityInfoResponseType {
    ResponseStatus?: ResponseStatusType
    cityInfos?: CityInfo[]
}

export interface CityInfo {
    /**
     * cityId
     */
    cityId?: number
    /**
     * provinceId
     */
    provinceId?: number
    /**
     * countryId
     */
    countryId?: number
    /**
     * 中文名
     */
    cityCnName?: string
    /**
     * 英文名
     */
    cityEnName?: string
    /**
     * 拼音字段
     */
    pinyin?: string
    /**
     * 简拼
     */
    jianpin?: string
    /**
     * 地区 ISO 或其他标准编码
     */
    code?: string
    /**
     * 纬度；国内高德，海外谷歌
     */
    glat?: number
    /**
     * 经度;国内高德,海外谷歌
     */
    glon?: number
}
