/**
 * Утренняя сводка подписчикам. По будням в 06:00 UTC.
 *
 * Разбор рынка считается один раз на всех: запрос к Twelve Data общий,
 * различается только язык сообщения.
 */
import { buildAnalysis } from '../../lib/analysis.js';
import { formatMorningSummary } from '../../lib/format.js';
import { listSubscribers, unsubscribe } from '../../lib/storage.js';
import { broadcast, createApi } from '../../lib/telegram.js';

/** Таймфрейм сводки: H4 даёт картину дня, а не внутричасовой шум. */
const SUMMARY_TIMEFRAME = '4h';

export default async () => {
  const subscribers = await listSubscribers();
  if (subscribers.length === 0) {
    console.log('[morning] подписчиков нет');
    return new Response('no subscribers');
  }

  let analysis;
  try {
    analysis = await buildAnalysis(SUMMARY_TIMEFRAME);
  } catch (error) {
    console.error('[morning] не удалось построить разбор:', error.message);
    return new Response(`skipped: ${error.message}`);
  }

  const api = createApi();
  const result = await broadcast(api, subscribers, (subscriber) =>
    formatMorningSummary(analysis, subscriber.lang ?? 'ru'),
  );

  // Пользователей, заблокировавших бота, убираем из рассылки:
  // иначе каждое утро будут бесполезные попытки доставки.
  for (const chatId of result.blocked) {
    await unsubscribe(chatId);
    console.log(`[morning] чат ${chatId} заблокировал бота, подписка снята`);
  }

  console.log(`[morning] доставлено ${result.sent}, не доставлено ${result.failed}`);
  return new Response(`sent ${result.sent}, failed ${result.failed}`);
};

export const config = {
  // Будни в 06:00 UTC. Поля: минута час день месяц день_недели.
  schedule: '0 6 * * 1-5',
};
