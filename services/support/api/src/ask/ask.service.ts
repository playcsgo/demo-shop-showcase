import { randomUUID } from 'node:crypto';
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { AiRunLog } from '../audit/ai-run-log.js';
import type { Customer, Staff } from '../auth/auth.service.js';
import type { Session } from '../auth/session.service.js';
import { ChatRealtime } from '../chat/chat.realtime.js';
import { ChatService, type Visibility } from '../chat/chat.service.js';
import { FixedWindowLimiter } from '../common/rate-limit.js';
import { ENV } from '../env.js';
import { LLM_RUNNER } from '../llm/llm.module.js';
import type { LlmMessage, LlmRun, LlmRunner } from '../llm/llm.types.js';
import { ProductIndex } from '../shop/index.js';
import { RunTokenService, type ToolRole } from '../tools/run-token.service.js';
import { ToolsService } from '../tools/tools.service.js';
import { HandoffService, type ReasonCode } from '../handoff/handoff.service.js';
import { CitationParser } from './citations.js';
import { routeMessage, summarize } from './router.js';
import { AGENT_PROMPT, CUSTOMER_PROMPT, productIndexBlock } from './prompts.js';

export const TEXT = {
  rateLimited: '訊息有點多，請稍等一下再傳。',
  busy: '目前詢問的人比較多，請稍等一下再傳。',
  failed: '抱歉，我現在查不到，請稍後再試。',
  superAiAlt: '（我是超級 AI）',
} as const;

const ROLE_OF: Record<string, LlmMessage['role']> = {
  customer: 'customer',
  agent: 'agent',
  ai: 'assistant',
  system: 'system_note',
};

interface AskJob {
  conversationId: string;
  actor: 'customer' | 'agent';
  role: ToolRole;
  customerId: number | null;
  agentId: number | null;
  visibility: Visibility; // 客戶的 Ask 是 public；客服問的是 internal，客戶看不到
  focus?: string; // Join：這次要查什麼（判斷閘門給的）
}

/**
 * Ask：組脈絡、發 run token、串流回答、解析引用、存結果。
 * 脈絡只來自資料庫裡這段對話的紀錄（spec §4）；同一段對話有新訊息時取消前一個執行
 */
@Injectable()
export class AskService implements OnApplicationShutdown {
  private readonly logger = new Logger('ask');
  private readonly active = new Map<string, LlmRun>();
  private readonly perSession = new FixedWindowLimiter(10, 60_000);
  private readonly pending = new Set<Promise<void>>();
  /** 每段對話（客戶端、客服端分開）目前最新一輪的編號 */
  private readonly thinkingTurn = new Map<string, number>();

  constructor(
    @Inject(LLM_RUNNER) private readonly llm: LlmRunner,
    @Inject(ToolsService) private readonly tools: ToolsService,
    @Inject(RunTokenService) private readonly tokens: RunTokenService,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(ChatRealtime) private readonly realtime: ChatRealtime,
    @Inject(AiRunLog) private readonly runs: AiRunLog,
    @Inject(ProductIndex) private readonly index: ProductIndex,
    @Inject(ENV) private readonly env: NodeJS.ProcessEnv,
    @Inject(HandoffService) private readonly handoffs: HandoffService,
  ) {}

  /** 客戶在 ask 對話送出訊息後呼叫。超過次數不呼叫模型：被洗版時不能燒額度 */
  answerCustomer(
    conversationId: string,
    session: Session,
    customer: Customer | null,
  ): Promise<void> {
    return this.track(this.handleCustomer(conversationId, session, customer));
  }

  /**
   * 先限流，再過路由判斷，才決定要不要進能呼叫工具的 Ask。
   * 攻擊訊息完全不進 Ask；路由失敗當成沒把握，直接轉真人
   */
  private async handleCustomer(
    conversationId: string,
    session: Session,
    customer: Customer | null,
  ) {
    if (!this.perSession.hit(session.hash)) {
      await this.realtime.publish(
        await this.chat.postSystem(conversationId, TEXT.rateLimited),
      );
      return;
    }
    await this.thinking(conversationId, 'public', () =>
      this.routeCustomer(conversationId, customer),
    );
  }

  /**
   * 前台的「輸入中」氣泡：從開始處理到結束，不管是回答、轉接還是出錯。
   * 新訊息會取消前一個回答，被取消的那個不能把新的氣泡關掉，所以只有最新一輪會送結束
   */
  private async thinking(
    conversationId: string,
    visibility: AskJob['visibility'],
    work: () => Promise<void>,
  ) {
    const key = `${conversationId}:${visibility}`;
    const turn = (this.thinkingTurn.get(key) ?? 0) + 1;
    this.thinkingTurn.set(key, turn);
    await this.realtime.emit(conversationId, visibility, 'ask:thinking', {
      active: true,
    });
    try {
      await work();
    } finally {
      if (this.thinkingTurn.get(key) === turn) {
        this.thinkingTurn.delete(key);
        await this.realtime.emit(conversationId, visibility, 'ask:thinking', {
          active: false,
        });
      }
    }
  }

  private async routeCustomer(
    conversationId: string,
    customer: Customer | null,
  ) {
    const route = await routeMessage(
      this.llm,
      conversationId,
      await this.contextOf(conversationId, 'customer'),
    );
    switch (route?.intent) {
      case 'normal':
        return this.execute({
          conversationId,
          actor: 'customer',
          role: customer ? 'customer' : 'anonymous',
          customerId: customer?.id ?? null,
          agentId: null,
          visibility: 'public',
        });
      case 'ask_is_ai':
        // AC-7：固定圖片，不由模型生成，也不否認
        await this.realtime.publish(
          await this.chat.postImage(
            conversationId,
            'super-ai',
            TEXT.superAiAlt,
          ),
        );
        return;
      case 'attack':
        return this.transfer(conversationId, 'cs', 'attack', true);
      case 'medical': {
        // AC-20：所有回答都不診斷。預防保養只推薦；輕微症狀推薦完直接轉獸醫；
        // 診斷、用藥、危險症狀不推薦，直接轉獸醫並建議就醫；等級拿不準時當成最嚴重
        const ask = () =>
          this.execute({
            conversationId,
            actor: 'customer',
            role: customer ? 'customer' : 'anonymous',
            customerId: customer?.id ?? null,
            agentId: null,
            visibility: 'public',
          });
        if (route.medicalLevel === 'prevention') return ask();
        if (route.medicalLevel === 'mild_symptom') {
          await ask();
          return this.transfer(conversationId, 'vet', 'medical');
        }
        return this.transfer(conversationId, 'vet', 'medical', false, true);
      }
      case 'wants_human':
      case 'upset':
        return this.transfer(conversationId, 'cs', route.intent);
      default:
        return this.transfer(conversationId, 'cs', 'router_failed');
    }
  }

  private transfer(
    conversationId: string,
    queue: 'cs' | 'vet',
    reason: ReasonCode,
    flaggedAttack = false,
    urgent = false,
  ) {
    return this.handoffs.handoff(conversationId, {
      queue,
      reason,
      flaggedAttack,
      urgent,
      summarize: async () =>
        summarize(
          this.llm,
          conversationId,
          await this.contextOf(conversationId, 'customer'),
        ),
    });
  }

  /** 脈絡只來自資料庫裡這段對話的紀錄；客戶這邊只看得到公開的訊息 */
  private async contextOf(
    conversationId: string,
    viewer: 'customer' | 'staff',
  ) {
    const history = await this.chat.history(conversationId, viewer);
    return history.map((m) => ({ role: ROLE_OF[m.sender], text: m.body }));
  }

  /** 客服在控制台問 AI。只查這段對話的客戶，回答只給客服 */
  answerAgent(
    conversationId: string,
    staff: Pick<Staff, 'id'>,
    focus?: string,
  ): Promise<void> {
    // 一被呼叫就登記成背景工作：不然在讀對話的空檔，idle() 和關閉服務都等不到它
    return this.track(this.agentFlow(conversationId, staff, focus));
  }

  private async agentFlow(
    conversationId: string,
    staff: Pick<Staff, 'id'>,
    focus?: string,
  ) {
    const conv = await this.chat.get(conversationId);
    await this.thinking(conversationId, 'internal', () =>
      this.execute({
        conversationId,
        actor: 'agent',
        role: focus ? 'join' : 'agent', // 只有 Join 會帶 focus
        customerId: conv?.customer_id ?? null,
        agentId: staff.id,
        visibility: 'internal',
        focus,
      }),
    );
  }

  /** 客服端還沒顯示完的建議取消掉（Join：客服已經回答了） */
  cancelAgent(conversationId: string) {
    this.active.get(`${conversationId}:agent`)?.cancel();
  }

  /** 背景中還在跑的回答都結束後才 resolve。關閉服務和測試切換時用：不然它們會繼續寫資料庫 */
  async idle(): Promise<void> {
    while (this.pending.size) await Promise.allSettled(this.pending);
  }

  async onApplicationShutdown() {
    for (const run of this.active.values()) run.cancel();
    await this.idle();
  }

  private run(job: AskJob): Promise<void> {
    return this.track(this.execute(job));
  }

  private track(work: Promise<void>): Promise<void> {
    const p = work.finally(() => this.pending.delete(p));
    this.pending.add(p);
    return p;
  }

  private async execute(job: AskJob) {
    const key = `${job.conversationId}:${job.actor}`;
    this.active.get(key)?.cancel(); // 新訊息進來，前一個回答已經過期

    const runId = randomUUID();
    await this.runs.start({
      id: runId,
      conversationId: job.conversationId,
      kind: 'ask',
      actor: job.actor,
      agentId: job.agentId,
      tier: 'main',
    });
    const token = this.tokens.issue({
      runId,
      conversationId: job.conversationId,
      role: job.role,
      customerId: job.customerId,
      agentId: job.agentId,
    });
    const history = await this.chat.history(
      job.conversationId,
      job.visibility === 'internal' ? 'staff' : 'customer',
    );
    const run = this.llm.run({
      conversationId: job.conversationId,
      tier: 'main',
      system:
        (job.actor === 'agent' ? AGENT_PROMPT : CUSTOMER_PROMPT) +
        productIndexBlock(await this.index.text()),
      messages: [
        ...history.map((m) => ({ role: ROLE_OF[m.sender], text: m.body })),
        ...(job.focus
          ? [{ role: 'system_note' as const, text: job.focus }]
          : []),
      ],
      mcp: {
        url: this.mcpUrl(),
        token,
        allowedTools: this.tools.listFor(job.role).map((t) => t.name),
      },
    });
    this.active.set(key, run);

    const parser = new CitationParser(this.tools.refLookup(runId));
    const refs: Record<string, unknown> = {};
    let answer = '';
    let ending: {
      status: 'done' | 'cancelled' | 'error';
      code?: string;
      ttftMs?: number | null;
      totalMs?: number;
    } = { status: 'error', code: 'unknown' };
    const relay = async (events: ReturnType<CitationParser['feed']>) => {
      for (const e of events) {
        if (e.type === 'text') {
          answer += e.text;
          await this.realtime.emit(
            job.conversationId,
            job.visibility,
            'ask:delta',
            { runId, text: e.text },
          );
        } else if (e.type === 'ref') {
          refs[e.key] = e.data;
          await this.realtime.emit(
            job.conversationId,
            job.visibility,
            'ask:ref',
            { runId, key: e.key, data: e.data },
          );
        } else {
          this.logger.warn(`${runId} 移除指向未查過資料的引用`); // 不記 key：可能帶客戶輸入的內容
        }
      }
    };

    try {
      for await (const event of run) {
        if (event.type === 'text') await relay(parser.feed(event.delta));
        else if (event.type === 'tool_result')
          await this.showWarnings(runId, job);
        else if (event.type === 'done') {
          await relay(parser.flush());
          ending = {
            status: 'done',
            ttftMs: event.usage.ttftMs,
            totalMs: event.usage.totalMs,
          };
        } else if (event.type === 'error')
          ending =
            event.code === 'cancelled'
              ? { status: 'cancelled' }
              : { status: 'error', code: event.code };
      }
    } catch {
      ending = { status: 'error', code: 'unknown' };
    } finally {
      this.tokens.revoke(token);
      if (this.active.get(key) === run) this.active.delete(key);
    }

    await this.runs.finish(runId, {
      status: ending.status,
      errorCode: ending.code,
      ttftMs: ending.ttftMs,
      totalMs: ending.totalMs,
    });
    const signals = this.tools.signals(runId);
    this.tools.forget(runId);
    await this.realtime.emit(job.conversationId, job.visibility, 'ask:end', {
      runId,
      status: ending.status,
    });
    if (ending.status === 'cancelled') return;
    const forCustomer = job.actor === 'customer';
    // AC-15：客戶端的 Ask 出錯就轉真人，不讓客戶只拿到一句「查不到」
    if (forCustomer && ending.status === 'error' && ending.code !== 'busy') {
      return this.transfer(job.conversationId, 'cs', 'ai_error');
    }

    const text =
      ending.status === 'done'
        ? answer.trim() || TEXT.failed
        : ending.code === 'busy'
          ? TEXT.busy
          : TEXT.failed;
    await this.realtime.publish(
      await this.chat.postAi(
        job.conversationId,
        text,
        job.visibility,
        ending.status === 'done' ? refs : null,
      ),
    );

    if (
      signals.some((s) => s.type === 'login') &&
      job.role === 'anonymous' &&
      (await this.chat.markLoginPrompted(job.conversationId))
    ) {
      await this.realtime.emit(job.conversationId, 'public', 'ask:login', {
        runId,
      });
    }
    const transfer = signals.find((s) => s.type === 'transfer');
    if (forCustomer && transfer?.type === 'transfer') {
      await this.transfer(job.conversationId, transfer.queue, 'ai_transfer');
    }
  }

  /** AC-21：警示立刻存成一則訊息，所以一定排在回答前面，回答被取消也還在 */
  private async showWarnings(runId: string, job: AskJob) {
    for (const w of this.tools.drainWarnings(runId)) {
      const body = w.warnings.length
        ? `「${w.name}」不適用的情況：${w.warnings.join('；')}`
        : `「${w.name}」資料未載明不適用的情況，不代表適合所有寵物，有疑慮請先問獸醫。`;
      await this.realtime.publish(
        await this.chat.postWarning(job.conversationId, body, job.visibility),
      );
    }
  }

  private mcpUrl() {
    return this.env.MCP_URL ?? `http://127.0.0.1:${this.env.PORT ?? 3000}/mcp`;
  }
}
