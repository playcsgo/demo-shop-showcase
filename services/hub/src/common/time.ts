/**
 * 時間壓縮（sandbox，TIME_SCALE）：hub 裡「設定出來的時間」全部同比例縮——呼叫廠商的逾時、重試間隔、斷路器冷卻。
 * 和 core、partners、SQS 一起縮，彼此的大小關係不變。縮不了的只有「真正做事的時間」（程式處理、DB、容器間傳輸），
 * 所以 core 的 sandbox:time-check 會檢查「縮完最短的逾時」還是真實處理時間的好幾倍。正式環境 TIME_SCALE=1。
 */
export const TIME_SCALE = Math.max(1, Number(process.env.TIME_SCALE ?? 1) || 1);
export const scaled = (ms: number): number => (ms <= 0 ? 0 : Math.max(1, Math.round(ms / TIME_SCALE)));
