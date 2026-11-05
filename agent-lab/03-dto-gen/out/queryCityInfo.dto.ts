export interface IQueryCityInfoRequestType {
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

export interface IQueryCityInfoResponseType {
    ResponseStatus?: IResponseStatusType
    cityInfos?: ICityInfo[]
    userInfos?: IUserInfo[]
}

export interface ICityInfo {
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

export interface IUserInfo {
    /**
     * uid
     */
    uid?: number
    /**
     * 名称
     */
    name?: string
    /**
     * 别名
     */
    alias?: string[]
}
