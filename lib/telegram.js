/**
 * Отправка сообщений вне обработчика бота.
 *
 * Функциям по расписанию не нужны ни команды, ни middleware — только
 * исходящие вызовы. Поэтому берём голый Api из grammY, а не весь Bot.
 */
import { Api } from 'grammy';
import { getTelegramConfig } from './config.js';

export function createApi() {
  return new Api(getTelegramConfig().token);
}

/**
 * Рассылка одного текста нескольким чатам.
 *
 * Важно: ошибка на одном получателе не должна останавливать рассылку.
 * Типичный случай — пользователь заблокировал бота: Telegram отвечает
 * 403, и этот чат нужно просто пропустить, доставив остальным.
 *
 * @returns {Promise<{sent: number, failed: number, blocked: number[]}>}
 */
export async function broadcast(api, recipients, buildText) {
  let sent = 0;
  let failed = 0;
  const blocked = [];

  for (const recipient of recipients) {
    const chatId = recipient.chatId ?? recipient;
    try {
      await api.sendMessage(chatId, buildText(recipient), { parse_mode: 'HTML' });
      sent += 1;
    } catch (error) {
      failed += 1;
      // 403 — бот заблокирован пользователем, чат стоит вычистить.
      if (error?.error_code === 403) blocked.push(chatId);
      console.error(`[telegram] не доставлено в чат ${chatId}:`, error?.description ?? error);
    }
  }

  return { sent, failed, blocked };
}
