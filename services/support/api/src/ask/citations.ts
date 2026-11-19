export type CitationEvent =
  | { type: 'text'; text: string }
  | { type: 'ref'; key: string; data: unknown }
  | { type: 'dropped'; key: string };

const OPEN = '[[ref:';
const MAX_MARKER = 120;

/**
 * 串流中解析 [[ref:<type>:<id>]]。引用只能指向這次執行工具真的回傳過的資料（lookup 查得到），
 * 其他一律移除並回報：模型無法編造引用。標記可能被切在兩個 chunk 中間，所以保留未完成的尾巴
 */
export class CitationParser {
  private buffer = '';
  private readonly emitted = new Set<string>();

  constructor(private readonly lookup: (key: string) => unknown) {}

  feed(chunk: string): CitationEvent[] {
    this.buffer += chunk;
    const out: CitationEvent[] = [];
    for (;;) {
      const start = this.buffer.indexOf('[[');
      if (start === -1) {
        // 結尾的單一個 [ 可能是被切開的 [[，留到下一個 chunk
        const hold = this.buffer.endsWith('[') ? 1 : 0;
        this.pushText(out, this.buffer.slice(0, this.buffer.length - hold));
        this.buffer = this.buffer.slice(this.buffer.length - hold);
        break;
      }
      this.pushText(out, this.buffer.slice(0, start));
      this.buffer = this.buffer.slice(start);
      const end = this.buffer.indexOf(']]');
      const couldBeRef =
        OPEN.startsWith(this.buffer.slice(0, OPEN.length)) ||
        this.buffer.startsWith(OPEN);
      if (!couldBeRef) {
        // 一般的方括號：輸出第一個字元，繼續往後找
        this.pushText(out, this.buffer[0]);
        this.buffer = this.buffer.slice(1);
        continue;
      }
      if (end === -1) {
        if (this.buffer.length > MAX_MARKER) {
          // 太長，不可能是引用
          this.pushText(out, this.buffer[0]);
          this.buffer = this.buffer.slice(1);
          continue;
        }
        break; // 等下一個 chunk
      }
      const key = this.buffer.slice(OPEN.length, end);
      this.buffer = this.buffer.slice(end + 2);
      const data = this.lookup(key);
      if (data === undefined) out.push({ type: 'dropped', key });
      else if (!this.emitted.has(key)) {
        this.emitted.add(key);
        out.push({ type: 'ref', key, data });
      }
    }
    return out;
  }

  flush(): CitationEvent[] {
    const out: CitationEvent[] = [];
    this.pushText(out, this.buffer);
    this.buffer = '';
    return out;
  }

  get refs(): string[] {
    return [...this.emitted];
  }

  private pushText(out: CitationEvent[], text: string) {
    if (!text) return;
    const last = out[out.length - 1];
    if (last?.type === 'text') last.text += text;
    else out.push({ type: 'text', text });
  }
}
