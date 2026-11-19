import { Inject, Logger } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import type { Namespace, Socket } from 'socket.io';
import { AuthService } from '../auth/auth.service.js';
import { allowedOrigins } from '../auth/origin.js';
import { ENV } from '../env.js';
import { AskService } from '../ask/ask.service.js';
import { JoinService } from '../join/join.service.js';
import { ChatRealtime } from './chat.realtime.js';
import { ChatError, ChatService, type Visibility } from './chat.service.js';

type Ack = { ok: true } | { ok: false; error: string };
const fail = (error: string): Ack => ({ ok: false, error });

function payload(p: unknown): { conversationId: string; body?: unknown } {
  const { conversationId, body } = (p ?? {}) as Record<string, unknown>;
  return {
    conversationId: typeof conversationId === 'string' ? conversationId : '',
    body,
  };
}

async function guarded(
  logger: Logger,
  socket: Socket,
  run: () => Promise<Ack>,
): Promise<Ack> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof ChatError)
      return fail(err.code === 'not_assigned' ? 'forbidden' : err.code);
    logger.error(`socket ${socket.id} 處理失敗`); // 不記 payload：裡面是對話內容
    return fail('error');
  }
}

/** 握手時檢查 Origin 和 cookie：cookie 會自動帶上，要防其他網站開連線冒用 */
function authenticate(
  ns: Namespace,
  env: NodeJS.ProcessEnv,
  resolve: (
    cookie: string | undefined,
  ) => Promise<Record<string, unknown> | null>,
) {
  const origins = allowedOrigins(env);
  ns.use((socket, next) => {
    if (!origins.has(String(socket.handshake.headers.origin)))
      return next(new Error('forbidden_origin'));
    resolve(socket.handshake.headers.cookie)
      .then((who) => {
        if (!who) return next(new Error('unauthorized'));
        socket.data = who;
        next();
      })
      .catch(() => next(new Error('unauthorized')));
  });
}

@WebSocketGateway({ namespace: '/customer' })
export class CustomerGateway implements OnGatewayInit {
  private readonly logger = new Logger('customer-ws');

  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(ChatRealtime) private readonly realtime: ChatRealtime,
    @Inject(ENV) private readonly env: NodeJS.ProcessEnv,
    @Inject(AskService) private readonly ask: AskService,
    @Inject(JoinService) private readonly joinAi: JoinService,
  ) {}

  afterInit(ns: Namespace) {
    this.realtime.customers = ns;
    authenticate(ns, this.env, (cookie) =>
      this.auth.customerFromCookies(cookie),
    );
  }

  /** 每個事件都重新確認 session，不只在連線時 */
  private async current(socket: Socket) {
    const who = await this.auth.customerFromCookies(
      socket.handshake.headers.cookie,
    );
    if (!who || who.session.hash !== socket.data.session?.hash) {
      socket.disconnect(true);
      throw new ChatError('forbidden');
    }
    return who;
  }

  @SubscribeMessage('join')
  join(@ConnectedSocket() socket: Socket, @MessageBody() p: unknown) {
    return guarded(this.logger, socket, async () => {
      const { conversationId } = payload(p);
      const { session, customer } = await this.current(socket);
      if (
        !(await this.chat.customerCanAccess(conversationId, session, customer))
      )
        return fail('forbidden');
      await socket.join(`conv:${conversationId}`);
      return { ok: true };
    });
  }

  @SubscribeMessage('send')
  send(@ConnectedSocket() socket: Socket, @MessageBody() p: unknown) {
    return guarded(this.logger, socket, async () => {
      const { conversationId, body } = payload(p);
      const { session, customer } = await this.current(socket);
      const posted = await this.chat.postCustomer(
        conversationId,
        session,
        customer,
        body,
      );
      for (const message of posted) await this.realtime.publish(message);
      const conv = await this.chat.get(conversationId);
      for (const message of posted) this.joinAi.onMessage(conv, message);
      // 轉接之後（不是 active）AI 就不再回覆客戶（AC-19）
      if (conv?.mode === 'ask' && conv.status === 'active') {
        // 不等回答：送出的 ack 立刻回，回答用串流事件送
        void this.ask
          .answerCustomer(conversationId, session, customer)
          .catch(() => this.logger.error(`${conversationId} Ask 失敗`));
      }
      return { ok: true };
    });
  }
}

@WebSocketGateway({ namespace: '/staff' })
export class StaffGateway implements OnGatewayInit {
  private readonly logger = new Logger('staff-ws');

  constructor(
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ChatService) private readonly chat: ChatService,
    @Inject(ChatRealtime) private readonly realtime: ChatRealtime,
    @Inject(ENV) private readonly env: NodeJS.ProcessEnv,
    @Inject(AskService) private readonly ask: AskService,
    @Inject(JoinService) private readonly joinAi: JoinService,
  ) {}

  afterInit(ns: Namespace) {
    this.realtime.staff = ns;
    authenticate(ns, this.env, (cookie) => this.auth.staffFromCookies(cookie));
  }

  private async current(socket: Socket) {
    const who = await this.auth.staffFromCookies(
      socket.handshake.headers.cookie,
    );
    if (!who || who.session.hash !== socket.data.session?.hash) {
      socket.disconnect(true);
      throw new ChatError('forbidden');
    }
    return who;
  }

  @SubscribeMessage('join')
  join(@ConnectedSocket() socket: Socket, @MessageBody() p: unknown) {
    return guarded(this.logger, socket, async () => {
      const { conversationId } = payload(p);
      const { staff } = await this.current(socket);
      if (!(await this.chat.staffCanAccess(conversationId, staff)))
        return fail('forbidden');
      // agent:{id} 只有被指派的客服在：Join 和 AI 草稿之後只發到這裡
      await socket.join([`conv:${conversationId}`, `agent:${conversationId}`]);
      return { ok: true };
    });
  }

  @SubscribeMessage('send')
  send(@ConnectedSocket() socket: Socket, @MessageBody() p: unknown) {
    return this.post(socket, p, 'public');
  }

  /** 客服問 AI：問題存成內部備註，回答也只給客服 */
  @SubscribeMessage('ask')
  askAi(@ConnectedSocket() socket: Socket, @MessageBody() p: unknown) {
    return guarded(this.logger, socket, async () => {
      const { conversationId } = payload(p);
      const question = (p as { question?: unknown } | null)?.question;
      const { session, staff } = await this.current(socket);
      await this.realtime.publish(
        await this.chat.postAgent(
          conversationId,
          session,
          staff,
          question,
          'internal',
        ),
      );
      void this.ask
        .answerAgent(conversationId, staff)
        .catch(() => this.logger.error(`${conversationId} Ask 失敗`));
      return { ok: true };
    });
  }

  @SubscribeMessage('note')
  note(@ConnectedSocket() socket: Socket, @MessageBody() p: unknown) {
    return this.post(socket, p, 'internal');
  }

  private post(socket: Socket, p: unknown, visibility: Visibility) {
    return guarded(this.logger, socket, async () => {
      const { conversationId, body } = payload(p);
      const { session, staff } = await this.current(socket);
      const message = await this.chat.postAgent(
        conversationId,
        session,
        staff,
        body,
        visibility,
      );
      await this.realtime.publish(message);
      this.joinAi.onMessage(await this.chat.get(conversationId), message);
      return { ok: true };
    });
  }

  /** AC-8：Join 由客服手動開關，只有被指派的客服能開 */
  @SubscribeMessage('join:toggle')
  toggleJoin(@ConnectedSocket() socket: Socket, @MessageBody() p: unknown) {
    return guarded(this.logger, socket, async () => {
      const { conversationId } = payload(p);
      const on = (p as { on?: unknown } | null)?.on === true;
      const { staff } = await this.current(socket);
      return (await this.joinAi.toggle(conversationId, staff, on))
        ? { ok: true }
        : fail('forbidden');
    });
  }
}
