/**
 * Поддерживаемые таймфреймы.
 *
 * Названия совпадают со строками интервалов Twelve Data, чтобы не плодить
 * таблицу соответствий. Если появится провайдер с другими обозначениями,
 * перевод сделает его адаптер — остальной код про это знать не должен.
 */
export const TIMEFRAMES = ['15min', '1h', '4h', '1day'];
export const DEFAULT_TIMEFRAME = '1h';

/** Длительность таймфрейма в миллисекундах — нужна для времени жизни кэша. */
const DURATION_MS = {
  '15min': 15 * 60_000,
  '1h': 60 * 60_000,
  '4h': 4 * 60 * 60_000,
  '1day': 24 * 60 * 60_000,
};

export function isTimeframe(value) {
  return TIMEFRAMES.includes(value);
}

export function timeframeMs(timeframe) {
  return DURATION_MS[timeframe] ?? DURATION_MS[DEFAULT_TIMEFRAME];
}

/**
 * Приводит пользовательский ввод к известному таймфрейму.
 * Принимаем частые варианты написания: H1, 1H, 60min и т.п.
 * @returns {string|null} таймфрейм или null, если не распознан
 */
export function normalizeTimeframe(input) {
  if (!input) return DEFAULT_TIMEFRAME;

  const value = String(input).trim().toLowerCase();
  const aliases = {
    m15: '15min', '15m': '15min', '15': '15min', '15min': '15min',
    h1: '1h', '1h': '1h', '60min': '1h', '1hour': '1h',
    h4: '4h', '4h': '4h', '240min': '4h',
    d1: '1day', '1d': '1day', '1day': '1day', d: '1day', daily: '1day',
  };
  return aliases[value] ?? null;
}
