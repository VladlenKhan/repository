/**
 * Сборка бота grammY: регистрация команд и общая обработка ошибок.
 *
 * Сам объект бота создаётся здесь, а не в функции Netlify, чтобы
 * логику можно было импортировать в тесты и в scheduled-функции.
 */
import { Bot, InlineKeyboard } from 'grammy';
import { ConfigError, getBotInfo, getTelegramConfig, getWebAppUrl } from './config.js';
import { t, LANGS } from './i18n.js';
import {
  formatAlertList,
  formatAnalysis,
  formatCommands,
  formatLevels,
  formatMacro,
  formatStart,
} from './format.js';
import { buildAnalysis, buildLevels } from './analysis.js';
import { MacroError, describeRealYield, getRealYield } from './macro.js';
import { PricesError } from './prices.js';
import { DEFAULT_TIMEFRAME, TIMEFRAMES, normalizeTimeframe } from './timeframes.js';
import {
  getAlerts,
  getUserSettings,
  isSubscribed,
  saveUserSettings,
  subscribe,
  unsubscribe,
} from './storage.js';
import { MAX_ALERTS_PER_CHAT, addAlert, clearAlerts, parseAlertPrice } from './alerts.js';
import { getProvider } from './prices.js';
import { isMarketOpen } from './sessions.js';

/**
 * Промежуточный слой: подкладывает в контекст язык пользователя,
 * чтобы каждый обработчик не ходил в хранилище сам.
 */
async function attachSettings(ctx, next) {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  ctx.settings = chatId ? await getUserSettings(chatId) : { lang: 'ru' };
  ctx.lang = ctx.settings.lang;
  await next();
}

/**
 * Кнопка, открывающая веб-версию прямо внутри Telegram.
 *
 * Тип web_app открывает мини-приложение, а не внешний браузер: Telegram
 * передаёт в страницу подписанный профиль пользователя, и вход
 * выполняется без пароля.
 *
 * Возвращает null, если адрес сайта не задан — тогда кнопки просто нет.
 */
function webAppKeyboard(lang) {
  const url = getWebAppUrl();
  if (!url) return null;
  return new InlineKeyboard().webApp(t(lang, 'webapp.button'), `${url}/`);
}

/**
 * Ставит кнопку «Веб-версия» рядом с полем ввода в конкретном чате.
 *
 * Почему для каждого чата отдельно, а не один раз глобально: установка
 * кнопки «по умолчанию» (без chat_id) Telegram принимает, но не
 * применяет — её перекрывает настройка меню из BotFather, где задан
 * список команд. Установка для чата такого ограничения не имеет.
 *
 * Сбой здесь не должен ломать команду, поэтому ошибка только логируется.
 */
async function ensureMenuButton(ctx, lang) {
  const url = getWebAppUrl();
  if (!url || !ctx.chat) return;

  try {
    await ctx.api.setChatMenuButton({
      chat_id: ctx.chat.id,
      menu_button: {
        type: 'web_app',
        text: t(lang, 'webapp.menu'),
        web_app: { url: `${url}/` },
      },
    });
  } catch (error) {
    console.error('[bot] не удалось поставить кнопку меню:', error?.description ?? error);
  }
}

/** Клавиатура выбора языка. */
function langKeyboard(lang) {
  return new InlineKeyboard()
    .text(t(lang, 'lang.button.ru'), 'lang:ru')
    .text(t(lang, 'lang.button.en'), 'lang:en');
}

/**
 * Подбирает понятный текст под причину сбоя получения данных.
 * Вызывается только для PricesError — остальные ошибки разбирает
 * общий обработчик, см. handleError.
 */
function pricesErrorKey(error) {
  if (error.kind === 'rate_limit') return 'error.rateLimit';
  if (error.kind === 'unavailable') return 'error.unavailable';
  return 'error.noData';
}

/**
 * Единый обработчик ошибок: пишет причину в лог и отвечает пользователю
 * понятным текстом вместо молчания.
 */
async function handleError(err) {
  const cause = err.error ?? err;
  console.error('[bot] ошибка обработчика:', cause);
  try {
    const lang = err.ctx?.lang ?? 'ru';
    // Незаполненный ключ API — не сбой, а незавершённая настройка.
    // Пользователю об этом стоит сказать прямо, а не общей фразой.
    const key = cause instanceof ConfigError ? 'error.notConfigured' : 'error.generic';
    await err.ctx?.reply(t(lang, key));
  } catch (replyError) {
    // Сеть до Telegram недоступна — логируем и молча выходим, иначе
    // ошибка улетит наружу и функция вернёт 500.
    console.error('[bot] не удалось отправить сообщение об ошибке:', replyError);
  }
}

/**
 * Создаёт и настраивает бота.
 * @returns {Bot}
 */
export function createBot() {
  const { token } = getTelegramConfig();

  // botInfo избавляет от вызова getMe на холодном старте — см. config.js
  const botInfo = getBotInfo();
  const bot = new Bot(token, botInfo ? { botInfo } : undefined);

  /**
   * Граница перехвата ошибок.
   *
   * Важно: bot.catch() здесь НЕ подходит. В исходниках grammY обработчик
   * из bot.catch вызывается только из handleUpdates() — это путь long
   * polling. Вебхук идёт через handleUpdate(), который пробрасывает
   * ошибку наружу. В serverless это означало бы 500 и повторную доставку
   * того же апдейта Telegram'ом, то есть дубли сообщений у пользователя.
   * errorBoundary работает в обоих режимах, поэтому вешаем команды на него.
   */
  const safe = bot.errorBoundary(handleError);

  safe.use(attachSettings);

  safe.command('start', async (ctx) => {
    const name = ctx.from?.first_name ?? 'трейдер';
    const keyboard = webAppKeyboard(ctx.lang);

    await ctx.reply(formatStart(ctx.lang, name), {
      parse_mode: 'HTML',
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });

    // Кнопка появляется у каждого, кто начал диалог с ботом.
    await ensureMenuButton(ctx, ctx.lang);
  });

  safe.command('app', async (ctx) => {
    const keyboard = webAppKeyboard(ctx.lang);
    if (!keyboard) {
      await ctx.reply(t(ctx.lang, 'error.notConfigured'));
      return;
    }
    await ctx.reply(t(ctx.lang, 'webapp.hint'), { reply_markup: keyboard });
  });

  safe.command('help', async (ctx) => {
    await ctx.reply(formatCommands(ctx.lang), { parse_mode: 'HTML' });
  });

  safe.command('analysis', async (ctx) => {
    // Аргумент команды: /analysis 4h
    const raw = ctx.match?.trim();
    const timeframe = normalizeTimeframe(raw || DEFAULT_TIMEFRAME);

    if (timeframe === null) {
      await ctx.reply(
        t(ctx.lang, 'analysis.badTimeframe', { list: TIMEFRAMES.join(', ') }),
      );
      return;
    }

    try {
      const data = await buildAnalysis(timeframe);
      await ctx.reply(formatAnalysis(data, ctx.lang), { parse_mode: 'HTML' });
    } catch (error) {
      // Порядок важен: сначала убеждаемся, что это сбой поставщика
      // данных, и только тогда отвечаем. Если ответить до проверки,
      // чужая ошибка уйдёт наверх уже ПОСЛЕ отправки сообщения, и
      // общий обработчик пришлёт пользователю второе.
      if (!(error instanceof PricesError)) throw error;
      await ctx.reply(t(ctx.lang, pricesErrorKey(error)));
    }
  });

  safe.command('levels', async (ctx) => {
    try {
      const data = await buildLevels();
      await ctx.reply(formatLevels(data, ctx.lang), { parse_mode: 'HTML' });
    } catch (error) {
      if (!(error instanceof PricesError)) throw error;
      await ctx.reply(t(ctx.lang, pricesErrorKey(error)));
    }
  });

  safe.command('macro', async (ctx) => {
    try {
      const data = await getRealYield();
      await ctx.reply(formatMacro(data, describeRealYield(data), ctx.lang), {
        parse_mode: 'HTML',
      });
    } catch (error) {
      if (error instanceof MacroError) {
        const key =
          error.kind === 'unavailable' ? 'error.macroUnavailable' : 'error.macroNoData';
        await ctx.reply(t(ctx.lang, key));
        return;
      }
      throw error;
    }
  });

  safe.command('subscribe', async (ctx) => {
    const chatId = ctx.chat.id;
    if (await isSubscribed(chatId)) {
      await ctx.reply(t(ctx.lang, 'subscribe.already'));
      return;
    }

    const ok = await subscribe(chatId, ctx.lang);
    await ctx.reply(t(ctx.lang, ok ? 'subscribe.done' : 'subscribe.failed'));
  });

  safe.command('unsubscribe', async (ctx) => {
    const chatId = ctx.chat.id;
    if (!(await isSubscribed(chatId))) {
      await ctx.reply(t(ctx.lang, 'unsubscribe.notSubscribed'));
      return;
    }

    await unsubscribe(chatId);
    await ctx.reply(t(ctx.lang, 'unsubscribe.done'));
  });

  safe.command('alert', async (ctx) => {
    const raw = ctx.match?.trim();
    if (!raw) {
      await ctx.reply(t(ctx.lang, 'alert.usage'), { parse_mode: 'HTML' });
      return;
    }

    const target = parseAlertPrice(raw);
    if (target === null) {
      await ctx.reply(t(ctx.lang, 'alert.badPrice', { min: 100, max: 100000 }), {
        parse_mode: 'HTML',
      });
      return;
    }

    // Текущая цена нужна, чтобы определить направление пересечения.
    let current;
    try {
      ({ price: current } = await getProvider().getQuote());
    } catch (error) {
      if (!(error instanceof PricesError)) throw error;
      await ctx.reply(t(ctx.lang, pricesErrorKey(error)));
      return;
    }

    const result = await addAlert(ctx.chat.id, target, current);
    if (!result.ok) {
      const keys = {
        limit: 'alert.limit',
        same_price: 'alert.samePrice',
        storage: 'alert.storageFailed',
      };
      await ctx.reply(t(ctx.lang, keys[result.reason], { max: MAX_ALERTS_PER_CHAT }));
      return;
    }

    const lines = [
      t(ctx.lang, 'alert.created', {
        direction: t(ctx.lang, `alert.direction.${result.alert.direction}`),
        price: result.alert.price,
        current: current.toFixed(2),
      }),
    ];
    // Честно предупреждаем: в выходные проверка не идёт.
    if (!isMarketOpen()) lines.push('', t(ctx.lang, 'alert.marketClosed'));

    await ctx.reply(lines.join('\n'), { parse_mode: 'HTML' });
  });

  safe.command('alerts', async (ctx) => {
    const items = await getAlerts(ctx.chat.id);
    await ctx.reply(formatAlertList(items, ctx.lang), { parse_mode: 'HTML' });
  });

  safe.command('alerts_clear', async (ctx) => {
    await clearAlerts(ctx.chat.id);
    await ctx.reply(t(ctx.lang, 'alert.cleared'));
  });

  safe.command('lang', async (ctx) => {
    await ctx.reply(t(ctx.lang, 'lang.prompt'), { reply_markup: langKeyboard(ctx.lang) });
  });

  // Нажатие кнопки выбора языка.
  safe.callbackQuery(/^lang:(.+)$/, async (ctx) => {
    const chosen = ctx.match[1];
    if (!LANGS.includes(chosen)) {
      await ctx.answerCallbackQuery();
      return;
    }

    const chatId = ctx.chat?.id ?? ctx.from.id;
    await saveUserSettings(chatId, { lang: chosen });

    // Отвечаем уже на новом языке.
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(t(chosen, 'lang.changed'));
    await ensureMenuButton(ctx, chosen);
  });

  // Любая другая команда.
  safe.on('message:text', async (ctx) => {
    if (!ctx.message.text.startsWith('/')) return;
    await ctx.reply(t(ctx.lang, 'error.unknownCommand'));
  });

  return bot;
}
