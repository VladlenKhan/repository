/**
 * Шаг бумажной торговли по расписанию.
 *
 * Запускается каждые 15 минут вместе с проверкой алертов: закрывает
 * позиции, достигшие стопа или цели, и открывает новые по сигналам.
 *
 * Отдельная функция, а не часть alerts.mjs: у них разные условия
 * пропуска и разная цена сбоя.
 */
import { getChartCandles } from '../../lib/prices.js';
import { runTradingStep } from '../../lib/paper-trading.js';
import { isMarketOpen } from '../../lib/sessions.js';
import { getPositions, getTradingSettings, savePositions } from '../../lib/storage.js';
import { normalizeSettings } from '../../lib/trading.js';

export default async () => {
  if (!isMarketOpen()) {
    return new Response('skipped: market closed');
  }

  const settings = normalizeSettings((await getTradingSettings()) ?? {});
  const positions = await getPositions();

  // Если торговля выключена и открытых позиций нет — делать нечего,
  // и не нужно тратить кредиты на свечи.
  const hasOpen = positions.some((p) => p.status === 'open');
  if (!settings.enabled && !hasOpen) {
    return new Response('skipped: trading disabled');
  }

  let candles;
  try {
    candles = await getChartCandles({ timeframe: settings.timeframe, limit: 500 });
  } catch (error) {
    console.error('[trade-check] свечи недоступны:', error.message);
    return new Response(`skipped: ${error.message}`);
  }

  const result = await runTradingStep(candles, positions, settings);

  if (result.closed.length > 0 || result.opened.length > 0) {
    await savePositions(result.positions);
    console.log(
      `[trade-check] закрыто ${result.closed.length}, открыто ${result.opened.length}`,
    );
  }

  return new Response(`closed ${result.closed.length}, opened ${result.opened.length}`);
};

export const config = {
  schedule: '*/15 * * * *',
};
