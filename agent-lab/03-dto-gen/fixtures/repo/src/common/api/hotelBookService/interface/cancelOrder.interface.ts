export interface ICancelOrderRequestType {
    /**
     * 订单号
     */
    orderId: number
    /**
     * 取消原因
     */
    reason?: string
}

export interface ICancelOrderResponseType {
    ResponseStatus?: IResponseStatusType
    /**
     * 是否成功
     */
    success?: boolean
}
