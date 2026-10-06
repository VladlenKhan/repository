/**
 * Сценарий «разобрать рынок»: получить свечи, посчитать всё нужное
 * и вернуть готовый объект с данными.
 *
 * Отделён и от Telegram, и от форматирования: этим же сценарием будет
 * пользоваться утренняя сводка на следующем этапе.
 */
import { computeIndicators, describeRsi, detectTrend } from './indicators.js';
import { calculatePivotPoints, findNearestLevels, previousClosedCandle } from './levels.js';
import { getCandlesCached } from './prices.js';
import { getActiveSessions, isMarketOpen } from './sessions.js';

/**
 * Сколько свечей запрашиваем.
 *
 * EMA(200) требует минимум 200 значений, берём с запасом — на коротких
 * сериях индикатор честно вернёт null, и в сообщении будет прочерк.
 */
const CANDLE_LIMIT = 300;

/**
 * @param {string} timeframe
 * @param {Date} [now] - параметром для тестируемости
 */
export async function buildAnalysis(timeframe, now = new Date()) {
  const candles = await getCandlesCached({ timeframe, limit: CANDLE_LIMIT });

  const indicators = computeIndicators(candles);

  // Уровни считаем по предыдущей ЗАКРЫТОЙ свече: у текущей
  // high и low ещё меняются.
  const reference = previousClosedCandle(candles);
  const levels = reference
    ? findNearestLevels(calculatePivotPoints(reference), indicators.price)
    : null;

  return {
    timeframe,
    indicators,
    trend: detectTrend(indicators),
    rsiState: describeRsi(indicators.rsi14),
    levels,
    sessions: getActiveSessions(now),
    marketOpen: isMarketOpen(now),
  };
}

/**
 * Сценарий команды /levels: пивот-уровни на D1 и H4.
 *
 * Два запроса идут параллельно через Promise.all — последовательно они
 * съели бы вдвое больше времени из 10-секундного бюджета функции.
 *
 * Свечей берём немного: для пивотов нужна всего одна закрытая свеча,
 * и запрашивать 300 ради неё — лишний объём.
 */
export async function buildLevels() {
  const [daily, fourHour] = await Promise.all([
    getCandlesCached({ timeframe: '1day', limit: 5 }),
    getCandlesCached({ timeframe: '4h', limit: 5 }),
  ]);

  const dailyRef = previousClosedCandle(daily);
  const fourHourRef = previousClosedCandle(fourHour);

  return {
    // Текущая цена — закрытие последней (ещё формирующейся) H4-свечи.
    price: fourHour.at(-1)?.close ?? daily.at(-1)?.close ?? null,
    daily: dailyRef ? calculatePivotPoints(dailyRef) : null,
    fourHour: fourHourRef ? calculatePivotPoints(fourHourRef) : null,
  };
}
