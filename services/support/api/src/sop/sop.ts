import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

export interface SopClause {
  id: string; // S1、E2……判斷要引用到條目，例如「退款 SOP §E2」
  text: string;
}
export interface Sop {
  topic: string;
  title: string;
  trigger: string;
  steps: SopClause[];
  exceptions: SopClause[];
}

const TOPIC = /^[a-z]+$/;

function clauses(
  section: string,
  prefix: 'S' | 'E',
  file: string,
): SopClause[] {
  const out: SopClause[] = [];
  for (const line of section.split('\n')) {
    const m = /^- §([SE]\d+) (.+)$/.exec(line.trim());
    if (!m) continue;
    if (!m[1].startsWith(prefix)) throw new Error(`${file}：${m[1]} 放錯段落`);
    out.push({ id: m[1], text: m[2] });
  }
  return out;
}

/** 驗證失敗就拋錯：條目編號錯了，AI 的引用就會指到錯的規則 */
export function parseSop(file: string, text: string): Sop {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`${file}：缺少 front matter`);
  const meta = (parse(m[1]) ?? {}) as Record<string, unknown>;
  if (
    typeof meta.topic !== 'string' ||
    !TOPIC.test(meta.topic) ||
    `${meta.topic}.md` !== file
  ) {
    throw new Error(`${file}：topic 要和檔名一致`);
  }
  const section = (name: string) =>
    m[2]
      .split(/^## /m)
      .find((s) => s.startsWith(name))
      ?.slice(name.length)
      .trim() ?? '';
  const sop: Sop = {
    topic: meta.topic,
    title: typeof meta.title === 'string' ? meta.title : meta.topic,
    trigger: section('觸發條件'),
    steps: clauses(section('步驟'), 'S', file),
    exceptions: clauses(section('例外'), 'E', file),
  };
  const ids = [...sop.steps, ...sop.exceptions].map((c) => c.id);
  if (new Set(ids).size !== ids.length)
    throw new Error(`${file}：條目編號重複`);
  if (!sop.trigger || !sop.steps.length)
    throw new Error(`${file}：缺少觸發條件或步驟`);
  return sop;
}

/** 啟動時讀進記憶體並驗證；之後只查記憶體 */
export class SopBook {
  private constructor(private readonly sops: Map<string, Sop>) {}

  static load(dir: string): SopBook {
    const sops = new Map<string, Sop>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      const sop = parseSop(file, readFileSync(join(dir, file), 'utf8'));
      sops.set(sop.topic, sop);
    }
    return new SopBook(sops);
  }

  topics(): string[] {
    return [...this.sops.keys()];
  }

  get(topic: string): Sop | null {
    return this.sops.get(topic) ?? null;
  }

  clause(topic: string, id: string): SopClause | null {
    const sop = this.get(topic);
    return (
      [...(sop?.steps ?? []), ...(sop?.exceptions ?? [])].find(
        (c) => c.id === id,
      ) ?? null
    );
  }
}
