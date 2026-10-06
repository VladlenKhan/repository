#!/usr/bin/env node
/**
 * Регистрация (или удаление) вебхука в Telegram.
 *
 *   node scripts/set-webhook.js            # зарегистрировать
 *   node scripts/set-webhook.js --delete   # удалить
 *
 * Переменные берутся из окружения. Локально удобно запускать так:
 *   netlify env:import .env   (или просто экспортировать вручную)
 */
import { getSiteUrl, getTelegramConfig, ConfigError } from '../lib/config.js';

const WEBHOOK_PATH = '/api/bot';

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
  const shouldDelete = process.argv.includes('--delete');

  if (shouldDelete) {
    await callTelegram(token, 'deleteWebhook', { drop_pending_updates: false });
    console.log('✅ Вебхук удалён.');
    return;
  }

  const url = `${getSiteUrl()}${WEBHOOK_PATH}`;
  await callTelegram(token, 'setWebhook', {
    url,
    secret_token: webhookSecret,
    allowed_updates: ['message', 'callback_query'],
    // Не разгребаем очередь, накопившуюся пока бот лежал.
    drop_pending_updates: true,
  });
  console.log(`✅ Вебхук зарегистрирован: ${url}`);

  // Постоянная кнопка рядом с полем ввода: открывает веб-версию
  // как мини-приложение, не выходя из Telegram.
  await callTelegram(token, 'setChatMenuButton', {
    menu_button: {
      type: 'web_app',
      text: 'Веб-версия',
      web_app: { url: `${getSiteUrl()}/` },
    },
  });
  console.log('✅ Кнопка «Веб-версия» добавлена в меню бота');

  const me = await callTelegram(token, 'getMe', {});
  console.log(`\nБот: @${me.username}`);
  console.log(
    '\nЧтобы убрать лишний запрос getMe на холодном старте, добавьте\n' +
      'в переменные окружения Netlify такую строку:\n',
  );
  console.log(`TELEGRAM_BOT_INFO=${JSON.stringify(me)}`);

  const info = await callTelegram(token, 'getWebhookInfo', {});
  console.log('\nСостояние по данным Telegram:');
  console.log(`  url: ${info.url}`);
  console.log(`  ожидают обработки: ${info.pending_update_count}`);
  if (info.last_error_message) {
    console.log(`  ⚠️ последняя ошибка: ${info.last_error_message}`);
  }
}

main().catch((error) => {
  if (error instanceof ConfigError) {
    console.error(`❌ Ошибка конфигурации: ${error.message}`);
  } else {
    console.error(`❌ ${error.message}`);
  }
  process.exitCode = 1;
});
