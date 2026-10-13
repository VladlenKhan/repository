/**
 * Проверка подлинности данных, которые Telegram передаёт мини-приложению.
 *
 * Когда сайт открывается кнопкой из бота, Telegram кладёт в страницу
 * строку initData с профилем пользователя и подписью. Подпись считается
 * по токену бота, поэтому подделать её, не зная токена, нельзя — а значит
 * пароль для входа не нужен вовсе.
 *
 * Схема подписи (по документации Telegram):
 *   secret_key = HMAC_SHA256(ключ: "WebAppData", данные: токен бота)
 *   hash       = HMAC_SHA256(ключ: secret_key,  данные: строка проверки)
 *
 * Порядок именно такой: сначала "WebAppData" как КЛЮЧ, токен как ДАННЫЕ.
 * Если поменять местами, подпись сойдётся только сама с собой, и проверка
 * начнёт пропускать что угодно.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Данные старше этого срока считаем протухшими. */
export const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Проверяет initData и возвращает профиль пользователя.
 *
 * @param {string} initData - строка вида "query_id=...&user=...&hash=..."
 * @param {string} botToken
 * @param {{maxAgeMs?: number, now?: number}} [options]
 * @returns {{ok: true, user: object, authDate: number} | {ok: false, reason: string}}
 */
export function validateInitData(initData, botToken, options = {}) {
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now();

  if (typeof initData !== 'string' || initData.length === 0) {
    return { ok: false, reason: 'Пустые данные авторизации' };
  }

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, reason: 'Данные авторизации не разбираются' };
  }

  const hash = params.get('hash');
  if (!hash) return { ok: false, reason: 'В данных нет подписи' };

  // Строка проверки: поля, отсортированные по имени, через перевод строки.
  //
  // Тонкость: Telegram добавил поле signature для сторонней проверки по
  // открытому ключу. Источники расходятся в том, входит ли оно в строку
  // для проверки по токену бота. Поэтому считаем оба варианта и принимаем
  // совпадение с любым.
  //
  // Безопасность от этого не страдает: обе подписи считаются HMAC с
  // токеном бота, и не зная токена подделать нельзя ни ту, ни другую.
  const buildCheckString = (excludeSignature) => {
    const pairs = [];
    for (const [key, value] of params.entries()) {
      if (key === 'hash') continue;
      if (excludeSignature && key === 'signature') continue;
      pairs.push(`${key}=${value}`);
    }
    pairs.sort();
    return pairs.join('\n');
  };

  const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
  const given = Buffer.from(hash);

  const matches = (checkString) => {
    const expected = Buffer.from(
      createHmac('sha256', secretKey).update(checkString).digest('hex'),
    );
    return given.length === expected.length && timingSafeEqual(given, expected);
  };

  if (!matches(buildCheckString(true)) && !matches(buildCheckString(false))) {
    // В лог кладём только имена полей — ни подписи, ни токена.
    console.warn(
      '[telegram-auth] подпись не сошлась, поля:',
      [...params.keys()].sort().join(','),
    );
    return { ok: false, reason: 'Подпись не совпадает' };
  }

  // Свежесть: украденная строка не должна работать вечно.
  //
  // Проверяем сначала саму строку, а не результат Number(): отсутствующее
  // поле даёт null, а Number(null) — это 0, а не NaN. Через проверку
  // на конечность такое значение прошло бы незамеченным.
  const rawAuthDate = params.get('auth_date');
  if (!rawAuthDate) {
    return { ok: false, reason: 'Нет отметки времени' };
  }

  const authDate = Number(rawAuthDate);
  if (!Number.isFinite(authDate)) {
    return { ok: false, reason: 'Нет отметки времени' };
  }
  if (now - authDate * 1000 > maxAgeMs) {
    return { ok: false, reason: 'Данные авторизации устарели' };
  }

  let user;
  try {
    user = JSON.parse(params.get('user') ?? 'null');
  } catch {
    return { ok: false, reason: 'Профиль не разбирается' };
  }
  if (!user || typeof user.id !== 'number') {
    return { ok: false, reason: 'В данных нет пользователя' };
  }

  return { ok: true, user, authDate };
}

/**
 * Собирает отображаемое имя из профиля Telegram.
 * Логин у пользователя может отсутствовать — тогда берём имя.
 */
export function displayName(user) {
  if (user.username) return `@${user.username}`;
  return [user.first_name, user.last_name].filter(Boolean).join(' ') || `id${user.id}`;
}
