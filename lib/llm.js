/**
 * Слой языковой модели (Gemini).
 *
 * Две роли, и обе выбраны осознанно:
 *
 *  1. Объяснять рынок словами — то, в чём модель действительно сильна.
 *  2. Выносить суждение по сигналу — но в «теневом» режиме: вердикт
 *     записывается, сделка открывается в любом случае. Это даёт честное
 *     сравнение «одобренные моделью против отклонённых» на одних и тех
 *     же данных. Если бы отклонённые сделки не открывались, сравнивать
 *     было бы не с чем.
 *
 * Модель НЕ предсказывает цену и не решает, торговать ли. Ответ без
 * ключа или при сбое — отсутствие мнения, а не отказ в работе.
 */
import { getLlmConfig } from './config.js';

const TIMEOUT_MS = 8000;

export class LlmError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = 'LlmError';
    this.kind = kind;
  }
}

/**
 * Запрос к Gemini со структурированным ответом.
 *
 * responseSchema заставляет модель вернуть JSON заданной формы —
 * без него пришлось бы разбирать свободный текст и гадать, где ответ.
 */
async function ask(prompt, schema, options = {}) {
  const { apiKey, model, baseUrl, via } = getLlmConfig();

  const body = {
    // Роль указываем явно: Google принимает сообщение и без неё,
    // а шлюз Netlify отвечает «Please use a valid role».
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: options.temperature ?? 0.2,
      maxOutputTokens: options.maxTokens ?? 800,
      ...(schema ? { responseMimeType: 'application/json', responseSchema: schema } : {}),
    },
  };

  let response;
  try {
    // Google ждёт ключ в адресе, шлюз Netlify — в заголовке.
    const url =
      via === 'google'
        ? `${baseUrl}/models/${model}:generateContent?key=${apiKey}`
        : `${baseUrl}/v1beta/models/${model}:generateContent`;

    response = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(via === 'google' ? {} : { authorization: `Bearer ${apiKey}` }),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS),
    });
  } catch (error) {
    throw new LlmError('unavailable', `Gemini недоступен: ${error.message}`);
  }

  if (response.status === 429) throw new LlmError('rate_limit', 'Лимит запросов к Gemini исчерпан');
  if (!response.ok) {
    const details = await response.text().catch(() => '');
    // Текст ошибки пишем в лог одной строкой: ответы моделей
    // многострочные, и в логах функций их потом не собрать.
    console.error(
      `[llm] HTTP ${response.status} от ${baseUrl}: ${details.replace(/\s+/g, ' ').slice(0, 300)}`,
    );
    throw new LlmError('bad_response', `Модель ответила HTTP ${response.status}`);
  }

  const payload = await response.json().catch(() => null);
  const text = payload?.candidates?.[0]?.content?.parts?.[0]?.text;
  if (typeof text !== 'string') {
    throw new LlmError('bad_response', 'Gemini вернул ответ без текста');
  }

  if (!schema) return text;

  try {
    return JSON.parse(text);
  } catch {
    throw new LlmError('bad_response', 'Gemini вернул неразбираемый JSON');
  }
}

/* ======================= Объяснение рынка ======================= */

/** Сжимает разбор до текста, который помещается в запрос. */
export function describeContext(data) {
  const { market, structure, macro } = data;
  const lines = [];

  if (market) {
    lines.push(`Инструмент: ${market.symbol}, таймфрейм ${market.timeframe ?? '1h'}`);
    lines.push(`Цена: ${market.price?.toFixed(2)}`);
    lines.push(`Тренд по EMA: ${market.trend}`);
    lines.push(`EMA50 ${market.indicators?.ema50?.toFixed(2)}, EMA200 ${market.indicators?.ema200?.toFixed(2)}`);
    lines.push(`RSI(14) ${market.indicators?.rsi14?.toFixed(1)}, ATR(14) ${market.indicators?.atr14?.toFixed(2)}`);
    if (market.levels?.resistance) lines.push(`Ближайшее сопротивление: ${market.levels.resistance.value}`);
    if (market.levels?.support) lines.push(`Ближайшая поддержка: ${market.levels.support.value}`);
    lines.push(`Сессия: ${(market.sessions ?? []).join(', ') || 'затишье'}`);
  }

  if (structure) {
    lines.push(`Структура рынка: ${structure.trend ?? 'не определена'}`);
    lines.push(`Положение в диапазоне: ${structure.range?.zone ?? '—'} (${structure.range?.position ?? '—'})`);

    const recent = (structure.events ?? []).slice(-3);
    if (recent.length) {
      lines.push('Последние сломы структуры: ' +
        recent.map((e) => `${e.type} ${e.direction} на ${e.price.toFixed(2)}`).join('; '));
    }

    const zones = (structure.zones ?? []).slice(-5);
    if (zones.length) {
      lines.push('Незакрытые зоны рядом с ценой: ' +
        zones.map((z) => `${z.kind} ${z.direction} ${z.bottom.toFixed(2)}–${z.top.toFixed(2)}`).join('; '));
    }

    const pools = (structure.pools ?? []).slice(0, 4);
    if (pools.length) {
      lines.push('Скопления ликвидности: ' +
        pools.map((p) => `${p.price.toFixed(2)} (${p.side}, ×${p.count})`).join('; '));
    }
  }

  if (macro) {
    lines.push(`Реальная доходность США (${macro.seriesId}): ${macro.value}% на ${macro.date}`);
  }

  return lines.join('\n');
}

const COMMENTARY_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    observations: { type: 'array', items: { type: 'string' } },
    watchLevels: { type: 'array', items: { type: 'string' } },
    caution: { type: 'string' },
  },
  required: ['summary', 'observations'],
};

/**
 * Связный разбор текущей обстановки.
 *
 * В запросе прямо запрещено называть будущие цены и давать торговые
 * советы: модель этого не умеет, а звучать будет убедительно.
 */
export async function explainMarket(context, options = {}) {
  const prompt = `Ты аналитик рынка золота. Ниже — рассчитанные показатели.

${describeContext(context)}

Объясни обстановку по-русски, опираясь ТОЛЬКО на эти числа.

Строгие правила:
— не называй будущие цены и не предсказывай направление;
— не давай торговых советов, не пиши «покупать» или «продавать»;
— если показатели противоречат друг другу, так и скажи;
— пиши кратко и по делу, без вводных оборотов.

Ответь JSON:
  summary — два-три предложения о том, что происходит;
  observations — три-пять наблюдений, каждое со ссылкой на конкретное число;
  watchLevels — уровни, за которыми стоит следить, с пояснением почему;
  caution — чего эти данные НЕ показывают.`;

  return ask(prompt, COMMENTARY_SCHEMA, options);
}

/* ======================= Суждение по сигналу ======================= */

const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    approve: { type: 'boolean' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
    concerns: { type: 'array', items: { type: 'string' } },
  },
  required: ['approve', 'confidence', 'reason'],
};

/**
 * Оценка сигнала моделью.
 *
 * Возвращает мнение, а не команду. Вызывающая сторона записывает его
 * рядом со сделкой и открывает позицию независимо от вердикта —
 * только так потом можно сравнить одобренные с отклонёнными.
 */
export async function judgeSignal(signal, context, options = {}) {
  const prompt = `Ты оцениваешь торговый сетап по методологии Smart Money / ICT.

Сетап:
  стратегия: ${signal.strategy}
  направление: ${signal.direction === 'bullish' ? 'покупка' : 'продажа'}
  обоснование: ${signal.reason}
  вход: ${signal.entry?.toFixed(2)}

Обстановка:
${describeContext(context)}

Оцени, насколько сетап согласуется с обстановкой. Учти положение в
диапазоне, направление структуры, близость ликвидности и незакрытых зон.

Не предсказывай исход сделки — его не знает никто. Оцени только
согласованность сетапа с контекстом.

Ответь JSON:
  approve — согласуется ли сетап с обстановкой;
  confidence — уверенность от 0 до 1;
  reason — одно предложение с опорой на конкретные числа;
  concerns — что в этом сетапе настораживает.`;

  return ask(prompt, VERDICT_SCHEMA, { ...options, maxTokens: 400 });
}

/* ======================= Измерение пользы ======================= */

/**
 * Сравнение сделок, одобренных и отклонённых моделью.
 *
 * Смысл всей затеи: если у одобренных результат не лучше, слой не
 * добавляет ничего, кроме красивых объяснений, — и это надо знать.
 *
 * @param {Array} positions - закрытые сделки с полем llmVerdict
 */
export function measureLlmValue(positions) {
  const judged = positions.filter(
    (p) => p.status === 'closed' && p.llmVerdict && typeof p.llmVerdict.approve === 'boolean',
  );
  if (judged.length === 0) return null;

  const group = (list) => {
    if (list.length === 0) return { trades: 0, winRate: null, pnlMoney: 0, profitFactor: null };

    const wins = list.filter((p) => p.pnlMoney > 0);
    const grossWin = wins.reduce((s, p) => s + p.pnlMoney, 0);
    const grossLoss = Math.abs(
      list.filter((p) => p.pnlMoney <= 0).reduce((s, p) => s + p.pnlMoney, 0),
    );

    return {
      trades: list.length,
      winRate: Math.round((wins.length / list.length) * 1000) / 10,
      pnlMoney: Math.round(list.reduce((s, p) => s + p.pnlMoney, 0) * 100) / 100,
      profitFactor: grossLoss > 0 ? Math.round((grossWin / grossLoss) * 100) / 100 : null,
    };
  };

  const approved = group(judged.filter((p) => p.llmVerdict.approve));
  const rejected = group(judged.filter((p) => !p.llmVerdict.approve));

  return {
    judged: judged.length,
    approved,
    rejected,
    // Положительная разница означает, что отбор модели что-то даёт.
    edge:
      approved.profitFactor !== null && rejected.profitFactor !== null
        ? Math.round((approved.profitFactor - rejected.profitFactor) * 100) / 100
        : null,
  };
}
