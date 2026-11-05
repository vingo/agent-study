export interface IQueryRoomStatusRequestType {
    /**
     * 酒店 ID
     */
    hotelId: number
    /**
     * 入住日期
     */
    checkIn: string
}

export interface IQueryRoomStatusResponseType {
    ResponseStatus?: IResponseStatusType
    rooms?: IRoomStatus[]
}

export interface IRoomStatus {
    /**
     * 房型 ID
     */
    roomId?: number
    /**
     * 余量
     */
    quantity?: number
}
