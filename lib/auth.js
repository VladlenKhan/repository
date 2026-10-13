/**
 * Роли и сессии.
 *
 * Четыре роли по возрастанию прав:
 *   guest  — не вошёл, видит только витрину
 *   user   — вошёл через Telegram, видит рынок и график
 *   admin  — назначен владельцем, видит пользователей и состояние системы
 *   owner  — единственный, задан в переменных окружения, назначает админов
 *
 * Паролей нет вовсе: вход только через Telegram, который присылает профиль,
 * подписанный токеном бота. Хранить нечего — значит, и утечь нечему.
 *
 * Сессия — подписанный токен, а не запись в хранилище. На serverless это
 * избавляет от обращения к базе при каждом запросе.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export const ROLES = {
  GUEST: 'guest',
  USER: 'user',
  ADMIN: 'admin',
  OWNER: 'owner',
};

/** Порядок важен: по нему сравниваются права. */
const RANK = {
  [ROLES.GUEST]: 0,
  [ROLES.USER]: 1,
  [ROLES.ADMIN]: 2,
  [ROLES.OWNER]: 3,
};

/** Роли, которые владелец может назначать вручную. */
export const ASSIGNABLE_ROLES = [ROLES.USER, ROLES.ADMIN];

/** Хватает ли роли для действия. */
export function hasAtLeast(role, minimum) {
  return (RANK[role] ?? -1) >= (RANK[minimum] ?? Infinity);
}

export function isKnownRole(role) {
  return Object.values(ROLES).includes(role);
}

/** Срок жизни сессии. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Срок жизни одноразового кода входа.
 *
 * Код уходит ссылкой в чат и может осесть в истории браузера, поэтому
 * живёт минуты, а не дни: его хватает, чтобы перейти по ссылке, и не
 * хватает, чтобы воспользоваться найденной ссылкой назавтра.
 */
const LOGIN_CODE_TTL_MS = 5 * 60 * 1000;

/** Назначение токена: сессия или одноразовый вход по ссылке. */
export const TOKEN_KIND = { SESSION: 'session', LOGIN: 'login' };

const b64url = (input) => Buffer.from(input).toString('base64url');

function sign(data, secret) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * Выпускает токен сессии.
 * @param {{login: string, role: string}} account
 */
export function issueToken({ login, role }, secret, now = Date.now()) {
  const payload = b64url(
    JSON.stringify({ login, role, kind: TOKEN_KIND.SESSION, exp: now + SESSION_TTL_MS }),
  );
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Выпускает короткоживущий код для входа по ссылке.
 *
 * Отдельный вид токена нужен, чтобы код из ссылки нельзя было
 * использовать как обычную сессию: эндпоинты данных принимают
 * только session, а обменять код на сессию можно один раз.
 */
export function issueLoginCode({ login, role }, secret, now = Date.now()) {
  const payload = b64url(
    JSON.stringify({ login, role, kind: TOKEN_KIND.LOGIN, exp: now + LOGIN_CODE_TTL_MS }),
  );
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Проверяет токен и возвращает его содержимое.
 *
 * @param {string} token
 * @param {string} secret
 * @param {number|{now?:number, kind?:string}} [options] - ожидаемый вид
 *   токена и текущее время. Без указания вида принимается сессия:
 *   так код из ссылки не сойдёт за сессию по недосмотру.
 * @returns {{login:string, role:string, kind:string, exp:number}|null}
 */
export function verifyToken(token, secret, options = {}) {
  const { now = Date.now(), kind = TOKEN_KIND.SESSION } =
    typeof options === 'number' ? { now: options } : options;
  if (typeof token !== 'string') return null;

  const [payload, signature] = token.split('.');
  if (!payload || !signature) return null;

  const expected = sign(payload, secret);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  if (typeof data?.login !== 'string' || typeof data?.exp !== 'number') return null;
  if (data.exp < now) return null;
  if (!isKnownRole(data.role)) return null;

  // Токены, выпущенные до появления поля kind, считаем сессионными.
  const actualKind = data.kind ?? TOKEN_KIND.SESSION;
  if (actualKind !== kind) return null;

  return { ...data, kind: actualKind };
}
