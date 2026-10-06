/**
 * Сборка текстов сообщений.
 *
 * Все функции здесь чистые: принимают данные и язык, возвращают строку.
 * Никаких обращений к сети и к Telegram — это делает их пригодными
 * для юнит-тестов без моков.
 */
import { t } from './i18n.js';

/** Экранирование под parse_mode: 'HTML' в Telegram. */
export function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Добавляет обязательную оговорку в конец сообщения.
 * По требованиям каждое сообщение с анализом заканчивается этой строкой.
 */
export function withDisclaimer(text, lang) {
  return `${text}\n\n<i>${t(lang, 'disclaimer')}</i>`;
}

/** Список команд — используется и в /start, и в /help. */
export function formatCommands(lang) {
  return [
    t(lang, 'commands.title'),
    t(lang, 'commands.app'),
    t(lang, 'commands.analysis'),
    t(lang, 'commands.levels'),
    t(lang, 'commands.macro'),
    t(lang, 'commands.subscribe'),
    t(lang, 'commands.unsubscribe'),
    t(lang, 'commands.alert'),
    t(lang, 'commands.alerts'),
    t(lang, 'commands.alertsClear'),
    t(lang, 'commands.lang'),
    t(lang, 'commands.help'),
  ].join('\n');
}

/** Приветствие для /start. */
export function formatStart(lang, userName) {
  return [
    t(lang, 'start.greeting', { name: escapeHtml(userName) }),
    '',
    formatCommands(lang),
    '',
    t(lang, 'start.hint'),
  ].join('\n');
}

/** Число с двумя знаками или прочерк, если значение не посчиталось. */
export function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : '—';
}

/** Перечисление активных сессий словами. */
export function formatSessions(sessionIds, lang) {
  if (!sessionIds || sessionIds.length === 0) {
    return t(lang, 'analysis.session.none');
  }
  return sessionIds.map((id) => t(lang, `analysis.session.${id}`)).join(' + ');
}

/**
 * Сообщение команды /analysis.
 *
 * Функция чистая: получает уже посчитанные данные и только раскладывает
 * их в текст. Это позволяет проверять формат в тестах без обращения к API.
 *
 * @param {object} data
 * @param {string} data.timeframe
 * @param {object} data.indicators - результат computeIndicators
 * @param {string} data.trend - результат detectTrend
 * @param {string} data.rsiState - результат describeRsi
 * @param {object|null} data.levels - результат findNearestLevels
 * @param {string[]} data.sessions - активные сессии
 * @param {boolean} data.marketOpen
 * @param {string} lang
 */
export function formatAnalysis(data, lang) {
  const { timeframe, indicators, trend, rsiState, levels, sessions, marketOpen } = data;

  const lines = [
    t(lang, 'analysis.title', { timeframe }),
    '',
    t(lang, 'analysis.price', { price: formatNumber(indicators.price) }),
    t(lang, 'analysis.trend', { trend: t(lang, `analysis.trend.${trend}`) }),
    t(lang, 'analysis.ema', {
      ema50: formatNumber(indicators.ema50),
      ema200: formatNumber(indicators.ema200),
    }),
    t(lang, 'analysis.rsi', {
      rsi: formatNumber(indicators.rsi14, 1),
      state: t(lang, `analysis.rsi.${rsiState}`),
    }),
    t(lang, 'analysis.atr', { atr: formatNumber(indicators.atr14) }),
    '',
    t(lang, 'analysis.levels'),
  ];

  if (levels?.resistance) {
    lines.push(
      t(lang, 'analysis.resistance', {
        name: levels.resistance.name,
        value: formatNumber(levels.resistance.value),
      }),
    );
  }
  if (levels?.support) {
    lines.push(
      t(lang, 'analysis.support', {
        name: levels.support.name,
        value: formatNumber(levels.support.value),
      }),
    );
  }
  if (!levels?.resistance && !levels?.support) {
    lines.push(t(lang, 'analysis.noLevels'));
  }

  lines.push('', t(lang, 'analysis.session', { sessions: formatSessions(sessions, lang) }));

  if (!marketOpen) {
    lines.push(t(lang, 'analysis.marketClosed'));
  }

  // Обязательная оговорка в конце каждого сообщения с анализом.
  return withDisclaimer(lines.join('\n'), lang);
}

/**
 * Блок пивот-уровней одного таймфрейма.
 *
 * Уровни выводятся сверху вниз (от сопротивлений к поддержкам), как они
 * расположены на графике. Маркер показывает, где относительно уровня
 * находится цена — так видно, какой уровень ближайший.
 */
export function formatPivotBlock(pivots, price, lang) {
  const order = ['r3', 'r2', 'r1', 'pp', 's1', 's2', 's3'];

  return order
    .map((key) => {
      const value = pivots[key];
      // ▸ отмечает уровень прямо над ценой, ▹ — прямо под ней.
      const marker = value > price ? '🔼' : value < price ? '🔽' : '▪️';
      return t(lang, 'levels.row', {
        marker,
        name: key.toUpperCase(),
        value: formatNumber(value),
      });
    })
    .join('\n');
}

/**
 * Сообщение команды /levels.
 * @param {object} data
 * @param {number} data.price
 * @param {object|null} data.daily - пивоты D1
 * @param {object|null} data.fourHour - пивоты H4
 */
export function formatLevels(data, lang) {
  const { price, daily, fourHour } = data;
  const lines = [t(lang, 'levels.title'), '', t(lang, 'levels.price', { price: formatNumber(price) })];

  if (daily) {
    lines.push('', t(lang, 'levels.d1'), formatPivotBlock(daily, price, lang));
  }
  if (fourHour) {
    lines.push('', t(lang, 'levels.h4'), formatPivotBlock(fourHour, price, lang));
  }
  if (!daily && !fourHour) {
    lines.push('', t(lang, 'analysis.noLevels'));
  }

  lines.push('', `<i>${t(lang, 'levels.pivotNote')}</i>`);
  return withDisclaimer(lines.join('\n'), lang);
}

/**
 * Сообщение команды /macro.
 * @param {object} data - результат getRealYield
 * @param {string} state - результат describeRealYield
 */
export function formatMacro(data, state, lang) {
  const lines = [
    t(lang, 'macro.title'),
    '',
    t(lang, 'macro.value', { series: data.seriesId, value: formatNumber(data.value) }),
    t(lang, 'macro.date', { date: data.date }),
  ];

  if (data.change === null) {
    lines.push(t(lang, 'macro.noChange'));
  } else {
    // Знак «плюс» проставляем вручную: он важен для чтения.
    const sign = data.change > 0 ? '+' : '';
    lines.push(t(lang, 'macro.change', { change: `${sign}${data.change}` }));
  }

  lines.push(
    '',
    t(lang, 'macro.comment.title'),
    t(lang, `macro.comment.${state}`),
    '',
    `<i>${t(lang, 'macro.caveat')}</i>`,
  );

  return withDisclaimer(lines.join('\n'), lang);
}

/** Список активных уведомлений. */
export function formatAlertList(items, lang) {
  if (items.length === 0) {
    return t(lang, 'alert.list.empty');
  }

  const rows = items.map((alert, index) =>
    t(lang, 'alert.list.row', {
      index: index + 1,
      direction: alert.direction === 'above' ? '🔼' : '🔽',
      price: formatNumber(alert.price),
    }),
  );

  return [t(lang, 'alert.list.title'), ...rows, '', `<i>${t(lang, 'alert.list.hint')}</i>`].join('\n');
}

/** Сообщение о сработавшем уведомлении. */
export function formatAlertTriggered(alert, currentPrice, lang) {
  return t(lang, 'alert.triggered', {
    price: formatNumber(alert.price),
    current: formatNumber(currentPrice),
  });
}

/** Утренняя сводка: тот же разбор рынка, но с заголовком. */
export function formatMorningSummary(data, lang) {
  return `${t(lang, 'morning.title')}\n\n${formatAnalysis(data, lang)}`;
}
