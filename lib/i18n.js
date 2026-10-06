/**
 * Локализация сообщений бота.
 *
 * Словарь — обычный объект, без зависимостей. Функция t() подставляет
 * параметры вида {name}. Все тексты собраны здесь, чтобы обработчики
 * команд не содержали ни одной строки на естественном языке.
 */

export const LANGS = ['ru', 'en'];
export const FALLBACK_LANG = 'ru';

/** Проверка, что строка — поддерживаемый язык. */
export function isLang(value) {
  return LANGS.includes(value);
}

const DICT = {
  ru: {
    'start.greeting':
      '👋 Привет, {name}!\n\nЯ помогаю следить за золотом (XAU/USD): считаю индикаторы, показываю уровни и слежу за макрофоном.',
    'start.hint': 'Начните с команды /analysis — покажу текущую картину по рынку.',

    'commands.title': '<b>Команды</b>',
    'commands.analysis': '/analysis [таймфрейм] — разбор рынка (15min, 1h, 4h, 1day)',
    'commands.levels': '/levels — ключевые уровни на D1 и H4',
    'commands.macro': '/macro — реальная доходность облигаций США и её влияние на золото',
    'commands.subscribe': '/subscribe — подписка на утреннюю сводку',
    'commands.unsubscribe': '/unsubscribe — отписаться от сводки',
    'commands.alert': '/alert 4200 — уведомить, когда цена пересечёт уровень',
    'commands.alerts': '/alerts — список активных уведомлений',
    'commands.alertsClear': '/alerts_clear — удалить все уведомления',
    'commands.lang': '/lang — сменить язык',
    'commands.help': '/help — этот список',

    'lang.prompt': 'Выберите язык интерфейса:',
    'lang.changed': '✅ Язык переключён на русский.',
    'lang.button.ru': '🇷🇺 Русский',
    'lang.button.en': '🇬🇧 English',

    'error.generic': '⚠️ Что-то пошло не так. Попробуйте ещё раз через минуту.',
    'error.notConfigured': '🔧 Эта команда пока не настроена: администратору нужно добавить ключ API. Остальные команды работают.',
    'error.unknownCommand': 'Не знаю такой команды. Список доступных — /help',


    'analysis.title': '<b>XAU/USD</b> · {timeframe}',
    'analysis.price': '💰 Цена: <b>{price}</b>',
    'analysis.trend': '📈 Тренд: <b>{trend}</b>',
    'analysis.trend.up': 'восходящий',
    'analysis.trend.down': 'нисходящий',
    'analysis.trend.flat': 'в боковике',
    'analysis.trend.unknown': 'не определён',
    'analysis.ema': 'EMA 50 / 200: {ema50} / {ema200}',
    'analysis.rsi': 'RSI(14): {rsi} — {state}',
    'analysis.rsi.overbought': 'перекуплен',
    'analysis.rsi.oversold': 'перепродан',
    'analysis.rsi.neutral': 'нейтрально',
    'analysis.rsi.unknown': 'недостаточно данных',
    'analysis.atr': 'ATR(14): {atr} — средний ход за свечу',
    'analysis.levels': '<b>Ближайшие уровни</b>',
    'analysis.resistance': '🔼 Сопротивление {name}: {value}',
    'analysis.support': '🔽 Поддержка {name}: {value}',
    'analysis.noLevels': 'Уровни посчитать не удалось — мало данных',
    'analysis.session': '🕒 Сессия: {sessions}',
    'analysis.session.asia': 'Азия',
    'analysis.session.london': 'Лондон',
    'analysis.session.newyork': 'Нью-Йорк',
    'analysis.session.none': 'затишье между сессиями',
    'analysis.marketClosed': '🔒 Рынок закрыт (выходные). Данные — на момент закрытия.',
    'analysis.badTimeframe': 'Не знаю такой таймфрейм. Доступны: {list}',

    'error.rateLimit': '⏳ Лимит запросов к поставщику данных исчерпан. Попробуйте через пару минут.',
    'error.unavailable': '📡 Поставщик данных сейчас не отвечает. Попробуйте позже.',
    'error.noData': '🤷 Данных по инструменту не пришло. Попробуйте позже.',


    'levels.title': '<b>Ключевые уровни XAU/USD</b>',
    'levels.price': 'Текущая цена: <b>{price}</b>',
    'levels.d1': '<b>D1</b> (по вчерашнему дню)',
    'levels.h4': '<b>H4</b> (по прошлой четырёхчасовке)',
    'levels.row': '{marker} {name}: {value}',
    'levels.pivotNote': 'PP — центральный пивот, R — сопротивления, S — поддержки.',
    'levels.unavailable': 'Не удалось посчитать уровни: {reason}',

    'macro.title': '<b>Макрофон: реальная доходность США</b>',
    'macro.value': '📊 {series} (10 лет, TIPS): <b>{value}%</b>',
    'macro.date': 'Дата наблюдения: {date}',
    'macro.change': 'Изменение к прошлому значению: {change} п.п.',
    'macro.noChange': 'Предыдущего значения для сравнения нет.',
    'macro.comment.title': '<b>Как это обычно влияет на золото</b>',
    'macro.comment.negative':
      'Реальная доходность отрицательная: облигации не компенсируют инфляцию. Исторически такая среда для золота благоприятна — держать его не стоит упущенного процента.',
    'macro.comment.rising':
      'Реальная доходность растёт. Облигации становятся привлекательнее, а издержка владения золотом (оно не платит процентов) — выше. Обычно это давит на золото.',
    'macro.comment.falling':
      'Реальная доходность снижается. Упущенная выгода от владения золотом уменьшается, что исторически золоту помогает.',
    'macro.comment.stable':
      'Реальная доходность почти не меняется. Сильного макроимпульса для золота с этой стороны сейчас нет.',
    'macro.caveat': 'Связь статистическая и работает на длинных отрезках, а не на каждом дне.',

    'error.macroUnavailable': '📡 FRED сейчас не отвечает. Попробуйте позже.',
    'error.macroNoData': '🤷 FRED не вернул значений по серии. Попробуйте позже.',


    'subscribe.done': '✅ Подписка оформлена. Буду присылать сводку по будням в 06:00 UTC.',
    'subscribe.already': 'Вы уже подписаны. Отписаться — /unsubscribe',
    'subscribe.failed': '⚠️ Не удалось сохранить подписку. Попробуйте позже.',
    'unsubscribe.done': '✅ Подписка отменена. Вернуться — /subscribe',
    'unsubscribe.notSubscribed': 'Вы и так не подписаны. Подписаться — /subscribe',

    'alert.usage': 'Укажите уровень цены. Например: <code>/alert 4200</code>',
    'alert.badPrice': 'Не похоже на цену золота. Укажите число от {min} до {max}, например: <code>/alert 4200</code>',
    'alert.created': '🔔 Уведомлю, когда цена пойдёт {direction} и достигнет <b>{price}</b>.\nСейчас: {current}',
    'alert.direction.above': 'вверх',
    'alert.direction.below': 'вниз',
    'alert.samePrice': 'Цена сейчас ровно на этом уровне. Укажите уровень выше или ниже текущего.',
    'alert.limit': 'Достигнут предел в {max} уведомлений. Очистить список — /alerts_clear',
    'alert.storageFailed': '⚠️ Не удалось сохранить уведомление. Попробуйте позже.',
    'alert.triggered': '🔔 <b>Сработало уведомление</b>\nЦена XAU/USD достигла <b>{price}</b>\nСейчас: <b>{current}</b>',
    'alert.list.title': '<b>Активные уведомления</b>',
    'alert.list.empty': 'Активных уведомлений нет. Создать — <code>/alert 4200</code>',
    'alert.list.row': '{index}. {direction} {price}',
    'alert.list.hint': 'Уведомление срабатывает один раз и после этого удаляется.',
    'alert.cleared': '✅ Все уведомления удалены.',
    'alert.marketClosed': '🔒 Рынок закрыт, уведомление сохранено — проверю, когда торги возобновятся.',

    'morning.title': '☀️ <b>Утренняя сводка по золоту</b>',

    disclaimer: 'Это не финансовая рекомендация',
  },

  en: {
    'start.greeting':
      '👋 Hi, {name}!\n\nI track gold (XAU/USD): compute indicators, show key levels and watch the macro backdrop.',
    'start.hint': 'Start with /analysis — I will show you the current market picture.',

    'commands.title': '<b>Commands</b>',
    'commands.analysis': '/analysis [timeframe] — market breakdown (15min, 1h, 4h, 1day)',
    'commands.levels': '/levels — key levels on D1 and H4',
    'commands.macro': '/macro — US real yield and how it usually affects gold',
    'commands.subscribe': '/subscribe — subscribe to the morning summary',
    'commands.unsubscribe': '/unsubscribe — unsubscribe from the summary',
    'commands.alert': '/alert 4200 — notify me when price crosses a level',
    'commands.alerts': '/alerts — list active alerts',
    'commands.alertsClear': '/alerts_clear — remove all alerts',
    'commands.lang': '/lang — change language',
    'commands.help': '/help — this list',

    'lang.prompt': 'Choose the interface language:',
    'lang.changed': '✅ Language switched to English.',
    'lang.button.ru': '🇷🇺 Русский',
    'lang.button.en': '🇬🇧 English',

    'error.generic': '⚠️ Something went wrong. Please try again in a minute.',
    'error.notConfigured': '🔧 This command is not configured yet: the admin needs to add an API key. Other commands still work.',
    'error.unknownCommand': 'Unknown command. See /help for the list.',


    'analysis.title': '<b>XAU/USD</b> · {timeframe}',
    'analysis.price': '💰 Price: <b>{price}</b>',
    'analysis.trend': '📈 Trend: <b>{trend}</b>',
    'analysis.trend.up': 'upward',
    'analysis.trend.down': 'downward',
    'analysis.trend.flat': 'sideways',
    'analysis.trend.unknown': 'undefined',
    'analysis.ema': 'EMA 50 / 200: {ema50} / {ema200}',
    'analysis.rsi': 'RSI(14): {rsi} — {state}',
    'analysis.rsi.overbought': 'overbought',
    'analysis.rsi.oversold': 'oversold',
    'analysis.rsi.neutral': 'neutral',
    'analysis.rsi.unknown': 'not enough data',
    'analysis.atr': 'ATR(14): {atr} — average candle range',
    'analysis.levels': '<b>Nearest levels</b>',
    'analysis.resistance': '🔼 Resistance {name}: {value}',
    'analysis.support': '🔽 Support {name}: {value}',
    'analysis.noLevels': 'Could not compute levels — not enough data',
    'analysis.session': '🕒 Session: {sessions}',
    'analysis.session.asia': 'Asia',
    'analysis.session.london': 'London',
    'analysis.session.newyork': 'New York',
    'analysis.session.none': 'quiet hours between sessions',
    'analysis.marketClosed': '🔒 Market is closed (weekend). Data is as of the close.',
    'analysis.badTimeframe': 'Unknown timeframe. Available: {list}',

    'error.rateLimit': '⏳ Data provider rate limit reached. Please try again in a couple of minutes.',
    'error.unavailable': '📡 The data provider is not responding right now. Please try later.',
    'error.noData': '🤷 No data came back for this instrument. Please try later.',


    'levels.title': '<b>Key XAU/USD levels</b>',
    'levels.price': 'Current price: <b>{price}</b>',
    'levels.d1': '<b>D1</b> (from yesterday)',
    'levels.h4': '<b>H4</b> (from the last 4-hour candle)',
    'levels.row': '{marker} {name}: {value}',
    'levels.pivotNote': 'PP is the central pivot, R are resistances, S are supports.',
    'levels.unavailable': 'Could not compute levels: {reason}',

    'macro.title': '<b>Macro backdrop: US real yield</b>',
    'macro.value': '📊 {series} (10y TIPS): <b>{value}%</b>',
    'macro.date': 'Observation date: {date}',
    'macro.change': 'Change from the previous value: {change} pp',
    'macro.noChange': 'No previous value to compare with.',
    'macro.comment.title': '<b>How this usually affects gold</b>',
    'macro.comment.negative':
      'The real yield is negative: bonds do not compensate for inflation. Historically such an environment favours gold — holding it costs no forgone interest.',
    'macro.comment.rising':
      'The real yield is rising. Bonds look more attractive, and the cost of holding gold (it pays no interest) grows. This usually weighs on gold.',
    'macro.comment.falling':
      'The real yield is falling. The opportunity cost of holding gold shrinks, which has historically supported it.',
    'macro.comment.stable':
      'The real yield is roughly flat. No strong macro impulse for gold from this side right now.',
    'macro.caveat': 'The relationship is statistical and holds over long horizons, not on any given day.',

    'error.macroUnavailable': '📡 FRED is not responding right now. Please try later.',
    'error.macroNoData': '🤷 FRED returned no values for the series. Please try later.',


    'subscribe.done': '✅ Subscribed. I will send the summary on weekdays at 06:00 UTC.',
    'subscribe.already': 'You are already subscribed. To stop — /unsubscribe',
    'subscribe.failed': '⚠️ Could not save the subscription. Please try later.',
    'unsubscribe.done': '✅ Unsubscribed. To come back — /subscribe',
    'unsubscribe.notSubscribed': 'You are not subscribed. To subscribe — /subscribe',

    'alert.usage': 'Specify a price level. For example: <code>/alert 4200</code>',
    'alert.badPrice': 'That does not look like a gold price. Use a number between {min} and {max}, e.g. <code>/alert 4200</code>',
    'alert.created': '🔔 I will notify you when the price moves {direction} and reaches <b>{price}</b>.\nCurrently: {current}',
    'alert.direction.above': 'up',
    'alert.direction.below': 'down',
    'alert.samePrice': 'The price is exactly at that level right now. Pick a level above or below it.',
    'alert.limit': 'You have reached the limit of {max} alerts. Clear the list — /alerts_clear',
    'alert.storageFailed': '⚠️ Could not save the alert. Please try later.',
    'alert.triggered': '🔔 <b>Alert triggered</b>\nXAU/USD reached <b>{price}</b>\nCurrently: <b>{current}</b>',
    'alert.list.title': '<b>Active alerts</b>',
    'alert.list.empty': 'No active alerts. Create one — <code>/alert 4200</code>',
    'alert.list.row': '{index}. {direction} {price}',
    'alert.list.hint': 'An alert fires once and is removed afterwards.',
    'alert.cleared': '✅ All alerts removed.',
    'alert.marketClosed': '🔒 The market is closed; the alert is saved — I will check when trading resumes.',

    'morning.title': '☀️ <b>Morning gold summary</b>',

    disclaimer: 'This is not financial advice',
  },
};

/**
 * Возвращает строку по ключу.
 * @param {string} lang - 'ru' | 'en'
 * @param {string} key - ключ из словаря
 * @param {Record<string, string|number>} [params] - подстановки вида {name}
 */
export function t(lang, key, params = {}) {
  const dict = DICT[isLang(lang) ? lang : FALLBACK_LANG];
  // Если ключа нет в выбранном языке, берём русский, а не показываем сырой ключ.
  const template = dict[key] ?? DICT[FALLBACK_LANG][key];
  if (template === undefined) return key;

  return template.replace(/\{(\w+)\}/g, (match, name) =>
    name in params ? String(params[name]) : match,
  );
}
