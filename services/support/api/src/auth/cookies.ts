export const CUSTOMER_COOKIE = 'support_customer';
export const STAFF_COOKIE = 'support_staff';

export function readCookie(
  header: string | undefined,
  name: string,
): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name)
      return part.slice(i + 1).trim();
  }
  return undefined;
}

// localhost 是 http，所以沒有 Secure；正式環境要加
export const setCookie = (name: string, value: string) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 3600}`;
export const clearCookie = (name: string) =>
  `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
