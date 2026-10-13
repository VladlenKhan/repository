/**
 * Стратегии: превращают разметку структуры в сигналы на вход.
 *
 * Каждая стратегия отвечает на один вопрос: «произошло ли на ПОСЛЕДНЕЙ
 * свече событие, по которому мы входим». Не «был ли когда-то похожий
 * паттерн», а именно сейчас — иначе на истории находились бы входы,
 * которых в реальном времени не было.
 *
 * Все функции чистые. Сигнал не открывает позицию сам — он лишь
 * описывает намерение, а что с ним делать, решает журнал сделок.
 */

/** Все доступные стратегии с человеческими названиями. */
export const STRATEGIES = {
  fvgRetest: 'Возврат в имбаланс',
  obRetest: 'Возврат в order block',
  sweepReversal: 'Разворот после снятия ликвидности',
};

/**
 * Возврат цены в незакрытый имбаланс по направлению структуры.
 *
 * Логика: имбаланс — след импульса. Когда цена впервые возвращается
 * в него, методология ожидает продолжения в сторону импульса.
 *
 * Входим только по направлению структуры: против тренда возвраты
 * отрабатывают заметно хуже.
 */
function fvgRetest(candles, analysis) {
  const last = candles.at(-1);
  if (!last || !analysis.trend) return null;

  for (const gap of analysis.fvg) {
    // Зона должна быть задета именно сейчас, а не когда-то раньше.
    if (gap.mitigatedAt !== last.time) continue;
    if (gap.direction !== analysis.trend) continue;

    return {
      strategy: 'fvgRetest',
      direction: gap.direction,
      // Вход по текущей цене, защита — за границей зоны.
      entry: last.close,
      zone: { top: gap.top, bottom: gap.bottom },
      reason: `Возврат в ${gap.direction === 'bullish' ? 'бычий' : 'медвежий'} имбаланс ${gap.bottom.toFixed(2)}–${gap.top.toFixed(2)}`,
    };
  }

  return null;
}

/** То же самое для order block. */
function obRetest(candles, analysis) {
  const last = candles.at(-1);
  if (!last || !analysis.trend) return null;

  for (const block of analysis.orderBlocks) {
    if (block.mitigatedAt !== last.time) continue;
    if (block.direction !== analysis.trend) continue;

    return {
      strategy: 'obRetest',
      direction: block.direction,
      entry: last.close,
      zone: { top: block.top, bottom: block.bottom },
      reason: `Возврат в order block ${block.bottom.toFixed(2)}–${block.top.toFixed(2)}`,
    };
  }

  return null;
}

/**
 * Разворот после снятия ликвидности.
 *
 * Цена вышла за экстремум тенью и вернулась — заявки за уровнем
 * собрали, и методология ожидает движения в обратную сторону.
 *
 * Это единственная из трёх стратегий, которая входит ПРОТИВ
 * предыдущего движения, поэтому структура ей не фильтр.
 */
function sweepReversal(candles, analysis) {
  const last = candles.at(-1);
  if (!last) return null;

  const sweep = analysis.sweeps.find((s) => s.time === last.time);
  if (!sweep) return null;

  return {
    strategy: 'sweepReversal',
    direction: sweep.direction,
    entry: last.close,
    zone: {
      top: Math.max(sweep.price, last.high),
      bottom: Math.min(sweep.price, last.low),
    },
    reason: `Снято ${sweep.direction === 'bullish' ? 'минимум' : 'максимум'} ${sweep.price.toFixed(2)}, цена вернулась`,
  };
}

const DETECTORS = { fvgRetest, obRetest, sweepReversal };

/**
 * Все сигналы, сработавшие на последней свече.
 *
 * @param {Array} candles
 * @param {object} analysis - результат analyzeStructure
 * @param {{strategies?: Record<string, boolean>}} [settings]
 */
export function findSignals(candles, analysis, settings = {}) {
  const enabled = settings.strategies ?? {};
  const signals = [];

  for (const [name, detect] of Object.entries(DETECTORS)) {
    // Выключенная стратегия не проверяется вовсе.
    if (enabled[name] === false) continue;

    const signal = detect(candles, analysis);
    if (signal) signals.push(signal);
  }

  return signals;
}
