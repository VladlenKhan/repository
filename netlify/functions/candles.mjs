/**
 * Данные для графика.
 *
 * GET /api/candles?timeframe=1h
 *
 * Отдаёт свечи и ряды EMA, посчитанные тем же кодом, что использует бот,
 * — поэтому линии на графике совпадают с числами в ответе /analysis.
 *
 * Доступно всем, кто вошёл: это рыночные данные, персональных тут нет.
 */
import { verifyToken } from '../../lib/auth.js';
import { ConfigError, getPricesConfig, getSessionSecret } from '../../lib/config.js';
import { emaSeries } from '../../lib/indicators.js';
import { calculatePivotPoints, previousClosedCandle } from '../../lib/levels.js';
import { PricesError, getCandlesCached } from '../../lib/prices.js';
import { DEFAULT_TIMEFRAME, normalizeTimeframe } from '../../lib/timeframes.js';

const CANDLE_LIMIT = 300;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function extractToken(request) {
  const match = (request.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

/**
 * Приводит ряд индикатора к виду, который ждёт библиотека графика:
 * пары «время — значение», без незаполненных точек в начале.
 */
function toLinePoints(candles, series) {
  const points = [];
  for (let i = 0; i < candles.length; i++) {
    const value = series[i];
    if (value === null || value === undefined) continue;
    points.push({ time: Math.floor(candles[i].time / 1000), value });
  }
  return points;
}

export default async (request) => {
  let secret;
  try {
    secret = getSessionSecret();
  } catch (error) {
    if (error instanceof ConfigError) return json({ error: 'Сервис не настроен' }, 503);
    throw error;
  }

  if (!verifyToken(extractToken(request), secret)) {
    return json({ error: 'Нужно войти' }, 401);
  }

  const requested = new URL(request.url).searchParams.get('timeframe');
  const timeframe = normalizeTimeframe(requested ?? DEFAULT_TIMEFRAME);
  if (timeframe === null) {
    return json({ error: 'Неизвестный таймфрейм' }, 400);
  }

  try {
    const candles = await getCandlesCached({ timeframe, limit: CANDLE_LIMIT });
    const closes = candles.map((candle) => candle.close);
    const reference = previousClosedCandle(candles);

    return json({
      timeframe,
      symbol: getPricesConfig().symbol,
      // Библиотека графика ждёт время в секундах, а не в миллисекундах.
      candles: candles.map((candle) => ({
        time: Math.floor(candle.time / 1000),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      })),
      ema50: toLinePoints(candles, emaSeries(closes, 50)),
      ema200: toLinePoints(candles, emaSeries(closes, 200)),
      pivots: reference ? calculatePivotPoints(reference) : null,
    });
  } catch (error) {
    if (error instanceof PricesError) {
      const text =
        error.kind === 'rate_limit'
          ? 'Лимит запросов к поставщику данных исчерпан'
          : 'Поставщик данных недоступен';
      return json({ error: text }, 503);
    }
    console.error('[candles] сбой:', error);
    return json({ error: 'Не удалось получить свечи' }, 500);
  }
};

export const config = { path: '/api/candles' };
