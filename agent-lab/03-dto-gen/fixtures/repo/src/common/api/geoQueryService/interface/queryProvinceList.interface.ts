export interface QueryProvinceListRequestType {
    /**
     * countryId
     */
    countryId?: number
    /**
     * 语言
     */
    locale?: string
}

export interface QueryProvinceListResponseType {
    ResponseStatus?: ResponseStatusType
    provinces?: ProvinceInfo[]
}

export interface ProvinceInfo {
    /**
     * provinceId
     */
    provinceId?: number
    /**
     * 中文名
     */
    provinceCnName?: string
    /**
     * 英文名
     */
    provinceEnName?: string
}
