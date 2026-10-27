import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
export const digest = text => createHash('sha256').update(text).digest('hex');
export function validateTelegram(initData, botToken, maxAge = 300, now = Math.floor(Date.now()/1000)) {
  if (typeof initData !== 'string' || !initData || initData.length > 16384) throw new HttpError(401, 'Откройте приложение через Telegram.');
  const fields = new URLSearchParams(initData);
  const seen = new Set();
  for (const key of fields.keys()) { if (seen.has(key)) throw new HttpError(401, 'Повторяющиеся поля Telegram.'); seen.add(key); }
  const hash = fields.get('hash');
  if (!/^[a-f0-9]{64}$/i.test(hash || '')) throw new HttpError(401, 'Неверная подпись Telegram.');
  fields.delete('hash');
  const check = [...fields.entries()].sort(([a],[b]) => a < b ? -1 : a > b ? 1 : 0).map(([key,value]) => `${key}=${value}`).join('\n');
  const secret = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expected = createHmac('sha256', secret).update(check).digest();
  if (!timingSafeEqual(expected, Buffer.from(hash, 'hex'))) throw new HttpError(401, 'Неверная подпись Telegram.');
  const date = Number(fields.get('auth_date'));
  if (!Number.isSafeInteger(date) || date > now + 30 || now - date > maxAge) throw new HttpError(401, 'Сессия входа устарела. Заново откройте Mini App.');
  let user; try { user = JSON.parse(fields.get('user')); } catch { throw new HttpError(401, 'Нет пользователя Telegram.'); }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.first_name !== 'string') throw new HttpError(401, 'Некорректный пользователь Telegram.');
  return { id: String(user.id), firstName: user.first_name.slice(0,128), username: typeof user.username === 'string' && /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(user.username) ? user.username.toLowerCase() : null };
}

export function readConfig(env = process.env) {
  if (!env.BOT_TOKEN || env.BOT_TOKEN.includes('PASTE_') || !/^\d+:[A-Za-z0-9_-]{20,}$/.test(env.BOT_TOKEN)) throw new Error('Заполните BOT_TOKEN в .env: токен Telegram-бота из @BotFather.');
  const admins = (env.ADMIN_TELEGRAM_IDS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (!admins.length || admins.some(id => !/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id)))) throw new Error('Заполните ADMIN_TELEGRAM_IDS числовыми Telegram ID через запятую.');
  let url; try { url = new URL(env.PUBLIC_URL); } catch { throw new Error('Укажите PUBLIC_URL, например https://wallet.example.com'); }
  if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new Error('PUBLIC_URL должен содержать только origin, без пути, пароля и параметров.');
  const local = ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(env.NODE_ENV !== 'production' && local && url.protocol === 'http:')) throw new Error('Для PUBLIC_URL требуется HTTPS; HTTP разрешён только локально вне production.');
  const integer = (name, fallback, min, max) => { const n = Number(env[name] || fallback); if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Некорректный ${name}`); return n; };
  if(env.APP_ENCRYPTION_KEY&&!/^[a-f0-9]{64}$/i.test(env.APP_ENCRYPTION_KEY))throw new Error('APP_ENCRYPTION_KEY: 64 шестнадцатеричных символа (32 случайных байта).');
  const botUsername=(env.TELEGRAM_BOT_USERNAME||'').replace(/^@/,'');
  if(botUsername&&!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(botUsername))throw new Error('Некорректный TELEGRAM_BOT_USERNAME.');
  return { botToken:env.BOT_TOKEN, adminIds:new Set(admins), origin:url.origin, secure:url.protocol==='https:', host:env.HOST||'127.0.0.1', port:integer('PORT',3000,1,65535), dbPath:env.DB_PATH||'./data/fk-wallet.sqlite', authMaxAge:integer('AUTH_MAX_AGE_SECONDS',300,30,3600), sessionTtl:integer('SESSION_TTL_SECONDS',43200,300,86400),encryptionKey:env.APP_ENCRYPTION_KEY?Buffer.from(env.APP_ENCRYPTION_KEY,'hex'):null,botUsername };
}
