/**
 * Разбор обстановки языковой моделью.
 *
 * GET /api/ai?timeframe=1h
 *
 * Результат кэшируется: обстановка меняется не быстрее свечей, а
 * каждый запрос к модели стоит денег и времени.
 */
import { verifyToken } from '../../lib/auth.js';
import { ConfigError, getSessionSecret, hasLlm } from '../../lib/config.js';
import { LlmError, explainMarket } from '../../lib/llm.js';
import { buildAnalysis } from '../../lib/analysis.js';
import { analyzeStructure, summarizeForChart } from '../../lib/structure.js';
import { getChartCandles } from '../../lib/prices.js';
import { PricesError } from '../../lib/prices.js';
import { getCachedCandles, setCachedCandles } from '../../lib/storage.js';
import { DEFAULT_TIMEFRAME, normalizeTimeframe, timeframeMs } from '../../lib/timeframes.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function extractToken(request) {
  const match = (request.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export default async (request) => {
  let secret;
  try {
    secret = getSessionSecret();
  } catch (error) {
    if (error instanceof ConfigError) return json({ error: 'Сервис не настроен' }, 503);
    throw error;
  }

  if (!verifyToken(extractToken(request), secret)) return json({ error: 'Нужно войти' }, 401);

  if (!hasLlm()) {
    return json({ error: 'Разбор моделью не настроен: нет ключа GEMINI_API_KEY' }, 503);
  }

  const timeframe = normalizeTimeframe(
    new URL(request.url).searchParams.get('timeframe') ?? DEFAULT_TIMEFRAME,
  );
  if (!timeframe) return json({ error: 'Неизвестный таймфрейм' }, 400);

  // Разбор модели кэшируется на четверть таймфрейма — как и свечи,
  // на которых он построен. Повторные запросы бесплатны.
  const cacheKey = `ai:${timeframe}`;
  const cached = await getCachedCandles(cacheKey);
  if (cached) return json({ ...cached, cached: true });

  let analysis;
  let candles;
  try {
    analysis = await buildAnalysis(timeframe);
    candles = await getChartCandles({ timeframe, limit: 1000 });
  } catch (error) {
    if (error instanceof PricesError) return json({ error: 'Поставщик данных недоступен' }, 503);
    throw error;
  }

  const context = {
    market: {
      symbol: 'XAU/USD',
      timeframe,
      price: analysis.indicators.price,
      trend: analysis.trend,
      indicators: analysis.indicators,
      levels: analysis.levels,
      sessions: analysis.sessions,
    },
    structure: summarizeForChart(analyzeStructure(candles), candles),
  };

  let commentary;
  try {
    commentary = await explainMarket(context);
  } catch (error) {
    if (error instanceof LlmError) {
      const text = error.kind === 'rate_limit'
        ? 'Лимит запросов к модели исчерпан, попробуйте позже'
        : 'Модель сейчас недоступна';
      return json({ error: text }, 503);
    }
    throw error;
  }

  const result = {
    timeframe,
    generatedAt: Date.now(),
    price: analysis.indicators.price,
    commentary,
  };

  await setCachedCandles(cacheKey, result, Math.max(timeframeMs(timeframe) / 4, 60_000));

  return json(result);
};

export const config = { path: '/api/ai' };
