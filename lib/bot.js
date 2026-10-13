/**
 * Сборка бота grammY: меню, команды и обработка ошибок.
 *
 * Весь интерфейс построен на инлайн-кнопках: каждое действие доступно
 * и командой, и нажатием. Чтобы не дублировать логику, действия вынесены
 * в отдельные функции, а команды и обработчики нажатий только их вызывают.
 */
import { Bot, InlineKeyboard, Keyboard } from 'grammy';
import { ConfigError, getBotInfo, getTelegramConfig, getWebAppUrl, hasLlm } from './config.js';
import { LANGS, t } from './i18n.js';
import {
  formatAiCommentary,
  formatSignal,
  formatAlertList,
  formatAnalysis,
  formatCommands,
  formatLevels,
  formatMacro,
  formatStart,
} from './format.js';
import {
  getAlerts,
  getUserSettings,
  isSubscribed,
  saveUserSettings,
  subscribe,
  unsubscribe,
} from './storage.js';
import { MAX_ALERTS_PER_CHAT, addAlert, clearAlerts, parseAlertPrice } from './alerts.js';
import { buildAnalysis, buildLevels } from './analysis.js';
import { createLoginLink } from './accounts.js';
import { MacroError, describeRealYield, getRealYield } from './macro.js';
import { LlmError, explainMarket } from './llm.js';
import { analyzeStructure, summarizeForChart } from './structure.js';
import { scoreMarket } from './scoring.js';
import { computeIndicators } from './indicators.js';
import { calculateLevels, calculateLot, normalizeSettings } from './trading.js';
import { getTradingSettings } from './storage.js';
import { getChartCandles } from './prices.js';
import { PricesError, getProvider } from './prices.js';
import { isMarketOpen } from './sessions.js';
import { DEFAULT_TIMEFRAME, TIMEFRAMES, normalizeTimeframe } from './timeframes.js';

/* ======================= Клавиатуры ======================= */

/**
 * Главное меню. Веб-приложение идёт первой строкой во всю ширину —
 * это основной сценарий, остальное вспомогательное.
 */
function mainMenu(lang) {
  const keyboard = new InlineKeyboard();
  const url = getWebAppUrl();

  if (url) {
    keyboard.webApp(t(lang, 'menu.webapp'), `${url}/`).row();
  }

  return keyboard
    .text(t(lang, 'menu.signal'), 'go:signal')
    .text(t(lang, 'menu.analysis'), 'go:analysis')
    .row()
    .text(t(lang, 'menu.levels'), 'go:levels')
    .text(t(lang, 'menu.macro'), 'go:macro')
    .text(t(lang, 'menu.ai'), 'go:ai')
    .row()
    .text(t(lang, 'menu.alerts'), 'go:alerts')
    .row()
    .text(t(lang, 'menu.subscribe'), 'go:subscribe')
    .text(t(lang, 'menu.lang'), 'go:lang')
    .row()
    .text(t(lang, 'menu.login'), 'go:login');
}

/**
 * Постоянная клавиатура над полем ввода.
 *
 * Рядом со скрепкой Telegram даёт только один слот: там может быть либо
 * кнопка веб-приложения, либо список команд, но не обе. Поэтому вторую
 * кнопку ставим сюда — клавиатура держится над полем ввода и доступна
 * всегда.
 *
 * Если адрес сайта не задан, остаётся одна кнопка меню.
 */
function persistentKeyboard(lang) {
  const url = getWebAppUrl();
  const keyboard = new Keyboard();

  if (url) keyboard.webApp(t(lang, 'keyboard.webapp'), `${url}/`);
  keyboard.text(t(lang, 'keyboard.menu'));

  return keyboard.resized().persistent();
}

/** Кнопка возврата в меню под каждым ответом. */
function backMenu(lang) {
  return new InlineKeyboard().text(t(lang, 'menu.back'), 'go:menu');
}

/** Выбор таймфрейма для анализа. */
function timeframeMenu(lang) {
  const keyboard = new InlineKeyboard();
  for (const tf of TIMEFRAMES) keyboard.text(tf, `tf:${tf}`);
  return keyboard.row().text(t(lang, 'menu.back'), 'go:menu');
}

function langMenu(lang) {
  return new InlineKeyboard()
    .text(t(lang, 'lang.button.ru'), 'lang:ru')
    .text(t(lang, 'lang.button.en'), 'lang:en')
    .row()
    .text(t(lang, 'menu.back'), 'go:menu');
}

/* ======================= Действия ======================= */
//
// Каждое действие умеет и отправить новое сообщение, и заменить текущее —
// при нажатии кнопки заменять удобнее, чат не засоряется.

/** Отправляет или редактирует сообщение в зависимости от источника. */
async function respond(ctx, text, keyboard) {
  const options = { parse_mode: 'HTML', reply_markup: keyboard };

  if (ctx.callbackQuery) {
    try {
      await ctx.editMessageText(text, options);
      return;
    } catch {
      // Текст мог не измениться — Telegram на это отвечает ошибкой.
      // Тогда просто шлём новое сообщение.
    }
  }
  await ctx.reply(text, options);
}

async function actionMenu(ctx) {
  await respond(ctx, t(ctx.lang, 'menu.title'), mainMenu(ctx.lang));
}

async function actionAnalysis(ctx, timeframe) {
  try {
    const data = await buildAnalysis(timeframe);
    await respond(ctx, formatAnalysis(data, ctx.lang), timeframeMenu(ctx.lang));
  } catch (error) {
    if (!(error instanceof PricesError)) throw error;
    await respond(ctx, t(ctx.lang, pricesErrorKey(error)), backMenu(ctx.lang));
  }
}

/**
 * Сводный сигнал: вердикт по нескольким факторам сразу.
 *
 * Уровни считаются по тем же настройкам, что и бумажная торговля, —
 * чтобы сообщение показывало ровно то, что система действительно
 * сделала бы, а не отдельный «красивый» расчёт.
 */
async function actionSignal(ctx, timeframe = DEFAULT_TIMEFRAME) {
  try {
    const candles = await getChartCandles({ timeframe, limit: 1000 });
    const indicators = computeIndicators(candles);
    const analysis = analyzeStructure(candles);
    const structure = summarizeForChart(analysis, candles);

    const score = scoreMarket({ candles, indicators, structure });
    const settings = normalizeSettings((await getTradingSettings()) ?? {});

    let levels = null;
    let lot = null;

    if (score.direction !== 'flat') {
      const direction = score.direction === 'long' ? 'bullish' : 'bearish';
      const signal = {
        direction,
        entry: indicators.price,
        // Зону берём из волатильности: сводный сигнал не привязан
        // к конкретному сетапу, в отличие от стратегий.
        zone: {
          top: indicators.price + (indicators.atr14 ?? 0),
          bottom: indicators.price - (indicators.atr14 ?? 0),
        },
      };

      const computed = calculateLevels(
        signal,
        { ...settings, stopMode: 'atr' },
        indicators.atr14,
      );

      // Слишком узкий стоп выбивается рыночным шумом, а огромный
      // объём под него опасен. На спокойном рынке ATR падает почти
      // до нуля — там уровни лучше не показывать вовсе.
      const tooTight =
        !computed || computed.riskPoints < Math.max(indicators.price * 0.0005, 1);

      if (computed && !tooTight) {
        levels = { ...computed, entry: indicators.price, rewardRatio: settings.rewardRatio };
        lot = calculateLot(settings, computed.riskPoints);
      }
    }

    await respond(
      ctx,
      formatSignal({ score, timeframe, price: indicators.price, levels, lot }, ctx.lang),
      timeframeMenu(ctx.lang),
    );
  } catch (error) {
    if (!(error instanceof PricesError)) throw error;
    await respond(ctx, t(ctx.lang, pricesErrorKey(error)), backMenu(ctx.lang));
  }
}

async function actionLevels(ctx) {
  try {
    const data = await buildLevels();
    await respond(ctx, formatLevels(data, ctx.lang), backMenu(ctx.lang));
  } catch (error) {
    if (!(error instanceof PricesError)) throw error;
    await respond(ctx, t(ctx.lang, pricesErrorKey(error)), backMenu(ctx.lang));
  }
}

async function actionMacro(ctx) {
  try {
    const data = await getRealYield();
    await respond(ctx, formatMacro(data, describeRealYield(data), ctx.lang), backMenu(ctx.lang));
  } catch (error) {
    if (!(error instanceof MacroError)) throw error;
    const key = error.kind === 'unavailable' ? 'error.macroUnavailable' : 'error.macroNoData';
    await respond(ctx, t(ctx.lang, key), backMenu(ctx.lang));
  }
}

async function actionAlerts(ctx) {
  const items = await getAlerts(ctx.chat.id);
  await respond(ctx, formatAlertList(items, ctx.lang), backMenu(ctx.lang));
}

/** Переключает подписку: одна кнопка вместо двух команд. */
async function actionSubscribe(ctx) {
  const chatId = ctx.chat.id;

  if (await isSubscribed(chatId)) {
    await unsubscribe(chatId);
    await respond(ctx, t(ctx.lang, 'unsubscribe.done'), backMenu(ctx.lang));
    return;
  }

  const ok = await subscribe(chatId, ctx.lang);
  await respond(ctx, t(ctx.lang, ok ? 'subscribe.done' : 'subscribe.failed'), backMenu(ctx.lang));
}

/**
 * Ссылка для входа в обычном браузере.
 *
 * Внутри Telegram профиль передаётся автоматически, а на компьютере
 * сайт открывается напрямую и подтвердить личность нечем. Бот знает,
 * кто его просит, поэтому выдаёт короткоживущий код.
 */
async function actionLogin(ctx) {
  const url = getWebAppUrl();
  if (!url) {
    await respond(ctx, t(ctx.lang, 'error.notConfigured'), backMenu(ctx.lang));
    return;
  }

  const link = await createLoginLink(ctx.from, url);

  await respond(
    ctx,
    `${t(ctx.lang, 'login.title')}\n\n${t(ctx.lang, 'login.body', { link })}`,
    backMenu(ctx.lang),
  );
}

/**
 * Разбор обстановки языковой моделью.
 *
 * Модель получает уже рассчитанные показатели и только излагает их
 * словами. Прогнозов и советов в запросе прямо запрещены.
 */
async function actionAi(ctx) {
  if (!hasLlm()) {
    await respond(ctx, t(ctx.lang, 'ai.notConfigured'), backMenu(ctx.lang));
    return;
  }

  // Запрос к модели занимает несколько секунд — показываем, что идёт работа.
  await respond(ctx, '🧠 …', backMenu(ctx.lang));

  try {
    const analysis = await buildAnalysis(DEFAULT_TIMEFRAME);
    const candles = await getChartCandles({ timeframe: DEFAULT_TIMEFRAME, limit: 1000 });

    const commentary = await explainMarket({
      market: {
        symbol: 'XAU/USD',
        timeframe: DEFAULT_TIMEFRAME,
        price: analysis.indicators.price,
        trend: analysis.trend,
        indicators: analysis.indicators,
        levels: analysis.levels,
        sessions: analysis.sessions,
      },
      structure: summarizeForChart(analyzeStructure(candles), candles),
    });

    await respond(ctx, formatAiCommentary({ commentary }, ctx.lang), backMenu(ctx.lang));
  } catch (error) {
    if (error instanceof LlmError) {
      await respond(ctx, t(ctx.lang, 'ai.unavailable'), backMenu(ctx.lang));
      return;
    }
    if (error instanceof PricesError) {
      await respond(ctx, t(ctx.lang, pricesErrorKey(error)), backMenu(ctx.lang));
      return;
    }
    throw error;
  }
}

async function actionLang(ctx) {
  await respond(ctx, t(ctx.lang, 'lang.prompt'), langMenu(ctx.lang));
}

/* ======================= Вспомогательное ======================= */

/**
 * Ставит кнопку «Веб-версия» рядом с полем ввода в конкретном чате.
 *
 * Для каждого чата отдельно, потому что установка «по умолчанию»
 * (без chat_id) Telegram принимает, но не применяет — её перекрывает
 * настройка меню из BotFather.
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

/** Подкладывает в контекст язык пользователя. */
async function attachSettings(ctx, next) {
  const chatId = ctx.chat?.id ?? ctx.from?.id;
  ctx.settings = chatId ? await getUserSettings(chatId) : { lang: 'ru' };
  ctx.lang = ctx.settings.lang;

  // Запоминаем имя пользователя Telegram, чтобы в панели был виден
  // не голый идентификатор. Пишем только при изменении: запись на
  // каждое сообщение — лишние обращения к хранилищу.
  const username = ctx.from?.username ?? null;
  const name = ctx.from?.first_name ?? null;
  if (chatId && (ctx.settings.username !== username || ctx.settings.name !== name)) {
    await saveUserSettings(chatId, { username, name });
  }

  await next();
}

/** Понятный текст под причину сбоя получения данных. */
function pricesErrorKey(error) {
  if (error.kind === 'rate_limit') return 'error.rateLimit';
  if (error.kind === 'unavailable') return 'error.unavailable';
  return 'error.noData';
}

/** Единый обработчик ошибок. */
async function handleError(err) {
  const cause = err.error ?? err;
  console.error('[bot] ошибка обработчика:', cause);
  try {
    const lang = err.ctx?.lang ?? 'ru';
    const key = cause instanceof ConfigError ? 'error.notConfigured' : 'error.generic';
    await err.ctx?.reply(t(lang, key));
  } catch (replyError) {
    console.error('[bot] не удалось отправить сообщение об ошибке:', replyError);
  }
}

/* ======================= Сборка ======================= */

export function createBot() {
  const { token } = getTelegramConfig();
  const botInfo = getBotInfo();
  const bot = new Bot(token, botInfo ? { botInfo } : undefined);

  /**
   * Граница перехвата ошибок.
   *
   * bot.catch здесь не подходит: в grammY он вызывается только из
   * handleUpdates(), то есть на пути long polling. Вебхук идёт через
   * handleUpdate(), который пробрасывает ошибку наружу — это дало бы
   * 500 и повторную доставку апдейта, то есть дубли у пользователя.
   */
  const safe = bot.errorBoundary(handleError);
  safe.use(attachSettings);

  /* ---------- Команды ---------- */

  safe.command('start', async (ctx) => {
    const url = getWebAppUrl();
    const keyboard = new InlineKeyboard();

    // Первым делом предлагаем открыть приложение: там регистрация
    // проходит сама, по аккаунту Telegram.
    if (url) keyboard.webApp(t(ctx.lang, 'register.cta'), `${url}/`).row();
    keyboard.text(t(ctx.lang, 'menu.analysis'), 'go:analysis')
      .text(t(ctx.lang, 'menu.levels'), 'go:levels')
      .row()
      .text(t(ctx.lang, 'menu.title').replace(/<\/?b>/g, ''), 'go:menu');

    await ctx.reply(
      `${t(ctx.lang, 'register.title')}\n\n${t(ctx.lang, 'register.body')}`,
      { parse_mode: 'HTML', reply_markup: keyboard },
    );

    // Клавиатура ставится отдельным сообщением: в одном нельзя передать
    // и инлайн-кнопки, и клавиатуру над полем ввода.
    await ctx.reply(t(ctx.lang, 'menu.title'), {
      parse_mode: 'HTML',
      reply_markup: persistentKeyboard(ctx.lang),
    });

    await ensureMenuButton(ctx, ctx.lang);
  });

  safe.command(['menu', 'help'], actionMenu);
  safe.command('app', async (ctx) => {
    const url = getWebAppUrl();
    if (!url) {
      await ctx.reply(t(ctx.lang, 'error.notConfigured'));
      return;
    }
    await ctx.reply(t(ctx.lang, 'webapp.hint'), {
      reply_markup: new InlineKeyboard().webApp(t(ctx.lang, 'menu.webapp'), `${url}/`),
    });
  });

  safe.command('analysis', async (ctx) => {
    const timeframe = normalizeTimeframe(ctx.match?.trim() || DEFAULT_TIMEFRAME);
    if (timeframe === null) {
      await ctx.reply(t(ctx.lang, 'analysis.badTimeframe', { list: TIMEFRAMES.join(', ') }));
      return;
    }
    await actionAnalysis(ctx, timeframe);
  });

  safe.command('levels', actionLevels);
  safe.command('macro', actionMacro);
  safe.command('alerts', actionAlerts);
  safe.command('lang', actionLang);
  safe.command('login', actionLogin);
  safe.command('ai', actionAi);
  safe.command('signal', (ctx) => actionSignal(ctx, normalizeTimeframe(ctx.match?.trim() || DEFAULT_TIMEFRAME) ?? DEFAULT_TIMEFRAME));

  safe.command('subscribe', async (ctx) => {
    if (await isSubscribed(ctx.chat.id)) {
      await ctx.reply(t(ctx.lang, 'subscribe.already'));
      return;
    }
    const ok = await subscribe(ctx.chat.id, ctx.lang);
    await ctx.reply(t(ctx.lang, ok ? 'subscribe.done' : 'subscribe.failed'));
  });

  safe.command('unsubscribe', async (ctx) => {
    if (!(await isSubscribed(ctx.chat.id))) {
      await ctx.reply(t(ctx.lang, 'unsubscribe.notSubscribed'));
      return;
    }
    await unsubscribe(ctx.chat.id);
    await ctx.reply(t(ctx.lang, 'unsubscribe.done'));
  });

  safe.command('alerts_clear', async (ctx) => {
    await clearAlerts(ctx.chat.id);
    await ctx.reply(t(ctx.lang, 'alert.cleared'));
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
    if (!isMarketOpen()) lines.push('', t(ctx.lang, 'alert.marketClosed'));

    await ctx.reply(lines.join('\n'), {
      parse_mode: 'HTML',
      reply_markup: backMenu(ctx.lang),
    });
  });

  safe.command('commands', async (ctx) => {
    await ctx.reply(formatCommands(ctx.lang), { parse_mode: 'HTML' });
  });

  /* ---------- Нажатия кнопок ---------- */

  const actions = {
    menu: actionMenu,
    analysis: (ctx) => actionAnalysis(ctx, DEFAULT_TIMEFRAME),
    levels: actionLevels,
    macro: actionMacro,
    alerts: actionAlerts,
    subscribe: actionSubscribe,
    lang: actionLang,
    login: actionLogin,
    ai: actionAi,
    signal: (ctx) => actionSignal(ctx),
  };

  safe.callbackQuery(/^go:(\w+)$/, async (ctx) => {
    // Отвечаем Telegram сразу, иначе на кнопке крутится индикатор.
    await ctx.answerCallbackQuery();
    const action = actions[ctx.match[1]];
    if (action) await action(ctx);
  });

  safe.callbackQuery(/^tf:(.+)$/, async (ctx) => {
    await ctx.answerCallbackQuery();
    const timeframe = normalizeTimeframe(ctx.match[1]);
    if (timeframe) await actionAnalysis(ctx, timeframe);
  });

  safe.callbackQuery(/^lang:(.+)$/, async (ctx) => {
    const chosen = ctx.match[1];
    await ctx.answerCallbackQuery();
    if (!LANGS.includes(chosen)) return;

    await saveUserSettings(ctx.chat?.id ?? ctx.from.id, { lang: chosen });
    ctx.lang = chosen;

    await ctx.editMessageText(t(chosen, 'lang.changed'), { reply_markup: backMenu(chosen) });

    // Подписи на клавиатуре тоже должны смениться.
    await ctx.reply(t(chosen, 'menu.title'), {
      parse_mode: 'HTML',
      reply_markup: persistentKeyboard(chosen),
    });

    await ensureMenuButton(ctx, chosen);
  });

  /**
   * Любое нажатие, не подошедшее под обработчики выше.
   *
   * Отвечать обязательно: пока Telegram не получил ответ, на кнопке
   * у пользователя крутится индикатор. Сюда попадают кнопки из старых
   * сообщений после обновления бота.
   */
  safe.on('callback_query', async (ctx) => {
    await ctx.answerCallbackQuery();
  });

  /* ---------- Прочее ---------- */

  safe.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();

    // Нажатие кнопки на клавиатуре приходит обычным сообщением.
    // Сверяем с обоими языками: человек мог сменить язык после того,
    // как клавиатура уже появилась.
    const menuLabels = LANGS.map((lang) => t(lang, 'keyboard.menu'));
    if (menuLabels.includes(text)) {
      await actionMenu(ctx);
      return;
    }

    if (!text.startsWith('/')) return;
    await ctx.reply(t(ctx.lang, 'error.unknownCommand'), { reply_markup: backMenu(ctx.lang) });
  });

  return bot;
}
