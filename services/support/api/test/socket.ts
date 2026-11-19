import { io, type Socket } from 'socket.io-client';
import { type Client, ORIGIN } from './http.js';

/** 用 Client 的 cookie 連 WebSocket；連不上時 reject */
export function connect(
  url: string,
  ns: '/customer' | '/staff',
  client?: Client,
  origin = ORIGIN,
): Promise<Socket> {
  const socket = io(url + ns, {
    transports: ['websocket'],
    extraHeaders: {
      origin,
      ...(client ? { cookie: client.cookieHeader } : {}),
    },
    reconnection: false,
    forceNew: true,
  });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (err) => {
      socket.close();
      reject(err);
    });
  });
}

export const ack = <T = { ok: boolean; error?: string }>(
  socket: Socket,
  event: string,
  payload: unknown,
) => socket.timeout(3000).emitWithAck(event, payload) as Promise<T>;

/** 收集某個事件；用來斷言「收不到」 */
export function record<T = unknown>(socket: Socket, event: string): T[] {
  const got: T[] = [];
  socket.on(event, (e: T) => got.push(e));
  return got;
}

export const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));

/** 等到斷線；逾時就 reject */
export const disconnected = (socket: Socket, ms = 2000) =>
  new Promise<void>((resolve, reject) => {
    if (socket.disconnected) return resolve();
    const timer = setTimeout(() => reject(new Error('沒有斷線')), ms);
    socket.once('disconnect', () => {
      clearTimeout(timer);
      resolve();
    });
  });
