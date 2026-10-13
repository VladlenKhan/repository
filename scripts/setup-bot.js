#!/usr/bin/env node
/**
 * Настройка бота в Telegram: вебхук, кнопка меню, описание и команды.
 *
 *   node scripts/setup-bot.js            # настроить всё
 *   node scripts/setup-bot.js --delete   # снять вебхук
 *
 * Описание — это и есть приветственный экран, который человек видит
 * ДО нажатия кнопки «Запустить», когда открывает бота впервые.
 */
import { getSiteUrl, getTelegramConfig, ConfigError } from '../lib/config.js';

const WEBHOOK_PATH = '/api/bot';

/** Текст на экране до запуска бота. До 512 символов. */
const DESCRIPTION = `Аналитика по золоту XAU/USD прямо в Telegram.

📈 Индикаторы: EMA 50/200, RSI, ATR
📐 Уровни поддержки и сопротивления
🏛 Макрофон: реальная доходность США
🔔 Уведомления о достижении цены
📊 Приложение со свечным графиком

Нажмите «Запустить», чтобы начать.`;

/** Короткое описание — показывается в профиле бота и в списке чатов. До 120 символов. */
const SHORT_DESCRIPTION = 'Аналитика золота XAU/USD: индикаторы, уровни, макрофон и уведомления о цене.';

const COMMANDS = [
  { command: 'menu', description: 'Главное меню' },
  { command: 'app', description: 'Открыть приложение с графиком' },
  { command: 'analysis', description: 'Разбор рынка' },
  { command: 'levels', description: 'Ключевые уровни D1 и H4' },
  { command: 'macro', description: 'Реальная доходность США' },
  { command: 'alert', description: 'Уведомить при достижении цены' },
  { command: 'alerts', description: 'Мои уведомления' },
  { command: 'subscribe', description: 'Подписка на утреннюю сводку' },
  { command: 'lang', description: 'Сменить язык' },
];

async function callTelegram(token, method, body) {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.ok) {
    throw new Error(`${method}: ${payload?.description ?? `HTTP ${response.status}`}`);
  }
  return payload.result;
}

async function main() {
  const { token, webhookSecret } = getTelegramConfig();

  if (process.argv.includes('--delete')) {
    await callTelegram(token, 'deleteWebhook', { drop_pending_updates: false });
    console.log('✅ Вебхук снят');
    return;
  }

  const site = getSiteUrl();

  await callTelegram(token, 'setWebhook', {
    url: `${site}${WEBHOOK_PATH}`,
    secret_token: webhookSecret,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  });
  console.log(`✅ Вебхук: ${site}${WEBHOOK_PATH}`);

  await callTelegram(token, 'setChatMenuButton', {
    menu_button: { type: 'web_app', text: 'Приложение', web_app: { url: `${site}/` } },
  });
  console.log('✅ Кнопка меню (по умолчанию; каждому чату бот ставит её сам при /start)');

  await callTelegram(token, 'setMyDescription', { description: DESCRIPTION });
  console.log('✅ Приветственный экран до запуска');

  await callTelegram(token, 'setMyShortDescription', { short_description: SHORT_DESCRIPTION });
  console.log('✅ Короткое описание');

  await callTelegram(token, 'setMyCommands', { commands: COMMANDS });
  console.log(`✅ Список команд (${COMMANDS.length})`);

  const me = await callTelegram(token, 'getMe', {});
  console.log(`\nБот: @${me.username}`);
  console.log(`\nДля ускорения холодного старта добавьте в окружение Netlify:`);
  console.log(`TELEGRAM_BOT_INFO=${JSON.stringify(me)}`);

  const info = await callTelegram(token, 'getWebhookInfo', {});
  if (info.last_error_message) {
    console.log(`\n⚠️ Последняя ошибка доставки: ${info.last_error_message}`);
  }
}

main().catch((error) => {
  console.error(error instanceof ConfigError ? `❌ Конфигурация: ${error.message}` : `❌ ${error.message}`);
  process.exitCode = 1;
});
