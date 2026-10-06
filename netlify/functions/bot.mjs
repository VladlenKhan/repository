/**
 * Вебхук Telegram. Netlify Functions v2: экспорт по умолчанию,
 * на входе стандартный Request, на выходе стандартный Response —
 * ровно то, что отдаёт адаптер grammY "std/http".
 */
import { webhookCallback } from 'grammy';
import { createBot } from '../../lib/bot.js';
import { getTelegramConfig } from '../../lib/config.js';

const { webhookSecret } = getTelegramConfig();

// Бот создаётся один раз на «тёплый» инстанс функции, а не на каждый запрос.
const bot = createBot();

const handleUpdate = webhookCallback(bot, 'std/http', {
  // Секрет из заголовка X-Telegram-Bot-Api-Secret-Token. Без него
  // на публичный адрес функции мог бы написать кто угодно.
  secretToken: webhookSecret,

  // На бесплатном тарифе Netlify функция живёт 10 секунд. Берём запас:
  // если обработчик не уложился, отвечаем Telegram 200 вместо падения,
  // иначе он будет слать тот же апдейт повторно.
  timeoutMilliseconds: 8000,
  onTimeout: 'return',
});

/**
 * Сверка секрета Telegram.
 *
 * grammY проверяет секрет сам, но делает это уже после bot.init(), то есть
 * после сетевого запроса getMe. Проверяем заранее, чтобы чужой запрос
 * отсекался сразу, не тратя ни времени, ни трафика.
 */
function hasValidSecret(request) {
  return request.headers.get('x-telegram-bot-api-secret-token') === webhookSecret;
}

export default async (request) => {
  if (request.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (!hasValidSecret(request)) {
    console.warn('[webhook] запрос с неверным секретом отклонён');
    return new Response('Unauthorized', { status: 401 });
  }

  try {
    return await handleUpdate(request);
  } catch (error) {
    console.error('[webhook] необработанная ошибка:', error);
    // 200, чтобы Telegram не ретраил заведомо сломанный апдейт.
    return new Response('OK', { status: 200 });
  }
};

export const config = {
  path: '/api/bot',
};
