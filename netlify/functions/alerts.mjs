/**
 * Проверка уведомлений о цене. Запускается каждые 15 минут.
 *
 * Бюджет запросов: 96 запусков в сутки по одному кредиту Twelve Data.
 * При лимите бесплатного тарифа в 800 кредитов это примерно восьмая часть,
 * и то лишь в будни — по выходным функция выходит сразу.
 */
import { collectTriggeredAlerts } from '../../lib/alerts.js';
import { formatAlertTriggered } from '../../lib/format.js';
import { getProvider } from '../../lib/prices.js';
import { isMarketOpen } from '../../lib/sessions.js';
import { getUserSettings } from '../../lib/storage.js';
import { createApi } from '../../lib/telegram.js';

export default async () => {
  // Рынок золота стоит с вечера пятницы до вечера воскресенья:
  // проверять нечего, а кредиты API тратились бы впустую.
  if (!isMarketOpen()) {
    console.log('[alerts] рынок закрыт, проверка пропущена');
    return new Response('skipped: market closed');
  }

  let price;
  try {
    ({ price } = await getProvider().getQuote());
  } catch (error) {
    // Падать нельзя: Netlify посчитает запуск неуспешным, а следующая
    // проверка всё равно через 15 минут.
    console.error('[alerts] не удалось получить цену:', error.message);
    return new Response(`skipped: ${error.message}`);
  }

  const triggered = await collectTriggeredAlerts(price);
  if (triggered.length === 0) {
    return new Response(`checked at ${price}, nothing triggered`);
  }

  const api = createApi();
  let sent = 0;

  for (const { chatId, alert } of triggered) {
    try {
      const { lang } = await getUserSettings(chatId);
      await api.sendMessage(chatId, formatAlertTriggered(alert, price, lang), {
        parse_mode: 'HTML',
      });
      sent += 1;
    } catch (error) {
      // Один недоступный получатель не должен срывать рассылку остальным.
      console.error(`[alerts] не доставлено в чат ${chatId}:`, error?.description ?? error);
    }
  }

  console.log(`[alerts] цена ${price}, сработало ${triggered.length}, доставлено ${sent}`);
  return new Response(`triggered ${triggered.length}, sent ${sent}`);
};

export const config = {
  schedule: '*/15 * * * *',
};
