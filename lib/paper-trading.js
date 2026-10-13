/**
 * Сценарий бумажной торговли: от сигнала до закрытия позиции.
 *
 * Отделён и от хранилища, и от расписания — чтобы ту же логику можно
 * было прогнать на истории в бэктесте.
 */
import { computeIndicators } from './indicators.js';
import { findSignals } from './strategies.js';
import { analyzeStructure } from './structure.js';
import { analyzeStructure as _unused, premiumDiscount, summarizeForChart } from './structure.js';
import { hasLlm } from './config.js';
import { judgeSignal } from './llm.js';
import { checkExit, closePosition, managePosition, openPosition } from './trading.js';

/**
 * Прогоняет один шаг торговли по текущим свечам.
 *
 * Порядок действий важен: сначала закрываем то, что должно закрыться,
 * и только потом открываем новое. Иначе свежая позиция могла бы занять
 * место, которое вот-вот освободится, а лимит открытых позиций
 * считался бы неверно.
 *
 * @param {Array} candles - свечи, последняя считается текущей
 * @param {Array} positions - журнал
 * @param {object} settings - нормализованные настройки
 * @param {number} [now]
 * @returns {{positions:Array, closed:Array, opened:Array}}
 */
export async function runTradingStep(candles, positions, settings, now = Date.now()) {
  const last = candles.at(-1);
  if (!last) return { positions, closed: [], opened: [] };

  const atrNow = computeIndicators(candles).atr14;

  const closed = [];
  const partials = [];
  const next = positions.map((position) => {
    if (position.status !== 'open') return position;

    const exit = checkExit(position, last);
    if (exit) {
      const result = closePosition(position, exit.outcome, exit.price, now, {
        spread: settings.spread ?? 0,
        swapPerNight: settings.swapPerNight ?? 0,
        stopSlippage: settings.stopSlippage ?? 0,
      });
      closed.push(result);
      return result;
    }

    // Управление применяется ПОСЛЕ проверки выхода: порядок внутри
    // свечи неизвестен, и обратный порядок завышал бы результат.
    const managed = managePosition(position, last, atrNow, settings.exits ?? {}, {
      spread: settings.spread ?? 0,
    });
    if (managed.partial) {
      partials.push(managed.partial);
      closed.push(managed.partial);
    }
    return managed.position;
  });

  const opened = [];
  if (settings.enabled) {
    const openCount = next.filter((p) => p.status === 'open').length;
    const room = settings.maxOpenPositions - openCount;

    if (room > 0) {
      const analysis = analyzeStructure(candles);
      const atr = atrNow;

      const range = premiumDiscount(candles, last.close);

      for (const signal of findSignals(candles, analysis, settings)) {
        if (opened.length >= room) break;
        if (!passesFilters(signal, settings, range)) continue;

        // Одна стратегия — одна открытая позиция: иначе на серии
        // сигналов журнал заполнится копиями одной и той же идеи.
        const alreadyOpen = next.some(
          (p) => p.status === 'open' && p.strategy === signal.strategy,
        );
        if (alreadyOpen) continue;

        const position = openPosition(signal, settings, atr, now);
        if (!position) continue;

        // Слишком узкий стоп выбивается рыночным шумом, а не движением
        // против идеи. Такие входы проверка на истории отсеивает как
        // убыточные.
        const minStop = (settings.filters?.minStopAtr ?? 0) * (atr ?? 0);
        if (minStop > 0 && position.riskPoints < minStop) continue;

        // Теневой режим: мнение модели записывается, но на открытие
        // не влияет. Если бы отклонённые сделки не открывались, не с
        // чем было бы сравнивать — и польза слоя осталась бы верой.
        if (settings.llmShadow && hasLlm()) {
          position.llmVerdict = await askModel(signal, candles, analysis, last);
        }

        opened.push(position);
      }
    }
  }

  return { positions: [...next, ...partials, ...opened], closed, opened };
}

/**
 * Мнение модели о сигнале.
 *
 * Сбой здесь не должен мешать торговле: сделка открывается в любом
 * случае, просто без вердикта.
 */
async function askModel(signal, candles, analysis, last) {
  try {
    return await judgeSignal(signal, {
      market: {
        symbol: 'XAU/USD',
        price: last.close,
        trend: analysis.trend,
        indicators: {},
      },
      structure: summarizeForChart(analysis, candles),
    });
  } catch (error) {
    console.error('[trading] модель не ответила:', error.message);
    return null;
  }
}

/**
 * Фильтры, отобранные по результатам проверки на истории.
 *
 * Покупка в дорогой половине диапазона и продажа в дешёвой — вход
 * против положения цены в диапазоне. На золоте такие сделки стабильно
 * ухудшали результат на всех проверенных таймфреймах.
 */
function passesFilters(signal, settings, range) {
  if (!settings.filters?.premiumDiscount || !range) return true;

  if (signal.direction === 'bullish' && range.zone === 'premium') return false;
  if (signal.direction === 'bearish' && range.zone === 'discount') return false;
  return true;
}
