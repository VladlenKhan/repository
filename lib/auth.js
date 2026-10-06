/**
 * Аутентификация и роли.
 *
 * Три роли:
 *   guest — не вошёл. Видит только витрину.
 *   user  — зарегистрировался. Видит рыночные данные.
 *   admin — владелец. Видит всё, включая пользователей и их уведомления.
 *
 * Пароли хранятся как scrypt-хеш с индивидуальной солью. scrypt выбран
 * потому, что он есть в стандартной библиотеке Node и намеренно медленный:
 * перебор по украденной базе обходится дорого. Обычный SHA-256 для паролей
 * не годится — он слишком быстрый.
 *
 * Сессия — подписанный токен, а не запись в хранилище. На serverless это
 * важно: проверка подписи не требует обращения к базе на каждый запрос.
 */
import { createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const ROLES = { GUEST: 'guest', USER: 'user', ADMIN: 'admin' };

/** Срок жизни сессии. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SCRYPT_KEYLEN = 64;

/* ======================= Пароли ======================= */

/** Создаёт хеш пароля с новой случайной солью. */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `scrypt:${salt}:${hash}`;
}

/** Проверяет пароль против сохранённого хеша. */
export function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;

  const [algorithm, salt, hash] = stored.split(':');
  if (algorithm !== 'scrypt' || !salt || !hash) return false;

  const candidate = scryptSync(password, salt, SCRYPT_KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  if (candidate.length !== expected.length) return false;

  // Сравнение за постоянное время: по длительности ответа нельзя
  // подбирать хеш побайтово.
  return timingSafeEqual(candidate, expected);
}

/* ======================= Токены сессии ======================= */

const b64url = (input) => Buffer.from(input).toString('base64url');

function sign(data, secret) {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

/**
 * Выпускает токен сессии.
 * @param {{login: string, role: string}} account
 * @param {string} secret
 */
export function issueToken({ login, role }, secret, now = Date.now()) {
  const payload = b64url(JSON.stringify({ login, role, exp: now + SESSION_TTL_MS }));
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Проверяет токен и возвращает его содержимое.
 * @returns {{login:string, role:string, exp:number}|null} null, если токен
 *   подделан, испорчен или просрочен
 */
export function verifyToken(token, secret, now = Date.now()) {
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
  if (!Object.values(ROLES).includes(data.role)) return null;

  return data;
}

/* ======================= Проверка данных формы ======================= */

/** Логин: латиница, цифры, дефис и подчёркивание, 3–32 символа. */
export function validateLogin(login) {
  const value = String(login ?? '').trim().toLowerCase();
  if (value.length < 3) return { ok: false, reason: 'Логин короче трёх символов' };
  if (value.length > 32) return { ok: false, reason: 'Логин длиннее 32 символов' };
  if (!/^[a-z0-9_-]+$/.test(value)) {
    return { ok: false, reason: 'В логине допустимы латиница, цифры, дефис и подчёркивание' };
  }
  return { ok: true, value };
}

/** Пароль: не короче восьми символов. */
export function validatePassword(password) {
  const value = String(password ?? '');
  if (value.length < 8) return { ok: false, reason: 'Пароль короче восьми символов' };
  if (value.length > 200) return { ok: false, reason: 'Пароль слишком длинный' };
  return { ok: true, value };
}
