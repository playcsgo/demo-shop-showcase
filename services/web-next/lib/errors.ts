/** 要回給瀏覽器的錯誤：狀態碼和內容照這裡寫的回（對應 NestJS 版的 HttpException） */
export class HttpError extends Error {
  readonly status: number
  readonly body: unknown
  constructor(status: number, body: unknown) {
    super(`HTTP ${status}`)
    this.status = status
    this.body = body
  }
}
