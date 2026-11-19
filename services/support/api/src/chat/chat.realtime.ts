import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import type { Namespace } from 'socket.io';
import { AuthService } from '../auth/auth.service.js';
import { SessionService } from '../auth/session.service.js';
import { ChatService, type Message } from './chat.service.js';

/**
 * 推送的唯一出口。客戶和員工在不同的 namespace：內部訊息只發到員工那邊，
 * 客戶的連線在結構上就收不到，不靠前端隱藏。
 *
 * 權限在推送當下逐一確認：加入房間之後才過期、被改派、角色改變的連線，
 * 不會因為還留在房間裡就繼續收到訊息
 */
@Injectable()
export class ChatRealtime implements OnModuleDestroy {
  customers?: Namespace;
  staff?: Namespace;
  private readonly unsubscribe: () => void;

  constructor(
    @Inject(SessionService) sessions: SessionService,
    @Inject(AuthService) private readonly auth: AuthService,
    @Inject(ChatService) private readonly chat: ChatService,
  ) {
    // 登出或 session 被撤銷時，用那個 session 開的連線都斷開
    this.unsubscribe = sessions.onRevoke((hash) => {
      for (const ns of [this.customers, this.staff]) {
        for (const socket of ns?.sockets.values() ?? [])
          if (socket.data.session?.hash === hash) socket.disconnect(true);
      }
    });
  }

  onModuleDestroy() {
    this.unsubscribe();
  }

  async publish(message: Message) {
    await this.emit(
      message.conversation_id,
      message.visibility,
      'message',
      message,
    );
  }

  /** AI 串流這類事件也走同一條路：public 給雙方，internal 只給被指派的客服，推送當下確認權限 */
  async emit(
    conversationId: string,
    visibility: 'public' | 'internal',
    event: string,
    payload: unknown,
  ) {
    const id = conversationId;
    if (visibility === 'public') {
      await this.deliver(this.customers, `conv:${id}`, event, payload, (hash) =>
        this.customerMayRead(hash, id),
      );
      await this.deliver(this.staff, `conv:${id}`, event, payload, (hash) =>
        this.staffMayRead(hash, id),
      );
    } else {
      await this.deliver(this.staff, `agent:${id}`, event, payload, (hash) =>
        this.staffMayRead(hash, id),
      );
    }
  }

  /** AC-18：現在有哪些角色的員工在線（連著 /staff） */
  onlineRoles(): Set<string> {
    const roles = new Set<string>();
    for (const socket of this.staff?.sockets.values() ?? [])
      if (socket.data.staff?.role) roles.add(socket.data.staff.role);
    return roles;
  }

  /** 只告訴線上員工佇列變了，不帶訊息內容 */
  queueChanged(conversationId: string) {
    this.staff?.emit('queue', { conversationId });
  }

  private async deliver(
    ns: Namespace | undefined,
    room: string,
    event: string,
    payload: unknown,
    mayRead: (hash: string) => Promise<'yes' | 'no_access' | 'no_session'>,
  ) {
    for (const socket of (await ns?.in(room).fetchSockets()) ?? []) {
      const verdict = await mayRead(String(socket.data.session?.hash));
      if (verdict === 'yes') socket.emit(event, payload);
      else if (verdict === 'no_session') socket.disconnect(true);
      else {
        // 沒有權限了：兩個房間都離開，之後的訊息也不會再進來
        const id = room.replace(/^(conv|agent):/, '');
        socket.leave(`conv:${id}`);
        socket.leave(`agent:${id}`);
      }
    }
  }

  private async customerMayRead(hash: string, id: string) {
    const who = await this.auth.customerBySession(hash);
    if (!who) return 'no_session';
    return (await this.chat.customerCanAccess(id, who.session, who.customer))
      ? 'yes'
      : 'no_access';
  }

  private async staffMayRead(hash: string, id: string) {
    const who = await this.auth.staffBySession(hash);
    if (!who) return 'no_session';
    return (await this.chat.staffCanAccess(id, who.staff))
      ? 'yes'
      : 'no_access';
  }
}
