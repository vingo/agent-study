export interface IQueryAirlineListRequestType {
    /**
     * 国家 ID
     */
    countryId?: number
}

export interface IQueryAirlineListResponseType {
    ResponseStatus?: IResponseStatusType
    airlines?: IAirlineInfo[]
}

export interface IAirlineInfo {
    /**
     * 二字码
     */
    code?: string
    /**
     * 航司名称
     */
    name?: string
}
