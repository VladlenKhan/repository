import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LlmError, describeContext, explainMarket, judgeSignal, measureLlmValue } from '../lib/llm.js';

const context = {
  market: {
    symbol: 'XAU/USD', timeframe: '1h', price: 4100, trend: 'up',
    indicators: { ema50: 4090, ema200: 4050, rsi14: 55, atr14: 12 },
    levels: { resistance: { value: 4120 }, support: { value: 4080 } },
    sessions: ['london'],
  },
  structure: {
    trend: 'bullish',
    range: { zone: 'discount', position: 0.3 },
    events: [{ type: 'BOS', direction: 'bullish', price: 4095 }],
    zones: [{ kind: 'fvg', direction: 'bullish', top: 4085, bottom: 4075 }],
    pools: [{ price: 4130, side: 'buy-side', count: 3 }],
  },
};

const reply = (object) => ({
  ok: true, status: 200,
  json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(object) }] } }] }),
});

beforeEach(() => {
  vi.stubEnv('GOOGLE_AI_KEY', 'test-key');
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('describeContext', () => {
  it('включает ключевые показатели', () => {
    const text = describeContext(context);

    expect(text).toContain('XAU/USD');
    expect(text).toContain('RSI');
    expect(text).toContain('discount');
  });

  it('не падает на неполных данных', () => {
    expect(() => describeContext({})).not.toThrow();
    expect(describeContext({})).toBe('');
  });
});

describe('explainMarket', () => {
  it('возвращает разобранный ответ', async () => {
    fetch.mockResolvedValue(reply({ summary: 'Рынок в боковике', observations: ['RSI 55'] }));

    const result = await explainMarket(context);
    expect(result.summary).toBe('Рынок в боковике');
  });

  it('требует структурированный ответ от модели', async () => {
    // Без схемы пришлось бы разбирать свободный текст и гадать.
    fetch.mockResolvedValue(reply({ summary: 'x', observations: [] }));
    await explainMarket(context);

    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.generationConfig.responseSchema).toBeDefined();
  });

  it('в запросе прямо запрещены прогнозы и советы', async () => {
    fetch.mockResolvedValue(reply({ summary: 'x', observations: [] }));
    await explainMarket(context);

    const prompt = JSON.parse(fetch.mock.calls[0][1].body).contents[0].parts[0].text;
    expect(prompt).toContain('не предсказывай');
    expect(prompt).toContain('не давай торговых советов');
  });

  it('сообщает об исчерпанном лимите', async () => {
    fetch.mockResolvedValue({ ok: false, status: 429, text: async () => '' });
    await expect(explainMarket(context)).rejects.toMatchObject({ kind: 'rate_limit' });
  });

  it('сообщает о недоступности', async () => {
    fetch.mockRejectedValue(new Error('сеть'));
    await expect(explainMarket(context)).rejects.toMatchObject({ kind: 'unavailable' });
  });

  it('не падает на неразбираемом ответе', async () => {
    fetch.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ candidates: [{ content: { parts: [{ text: 'не json' }] } }] }),
    });

    await expect(explainMarket(context)).rejects.toBeInstanceOf(LlmError);
  });

  it('не падает на ответе без текста', async () => {
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ candidates: [] }) });
    await expect(explainMarket(context)).rejects.toMatchObject({ kind: 'bad_response' });
  });
});

describe('judgeSignal', () => {
  const signal = { strategy: 'fvgRetest', direction: 'bullish', reason: 'возврат', entry: 4100 };

  it('возвращает вердикт с обоснованием', async () => {
    fetch.mockResolvedValue(reply({ approve: true, confidence: 0.7, reason: 'сходится со структурой' }));

    const verdict = await judgeSignal(signal, context);
    expect(verdict.approve).toBe(true);
    expect(verdict.confidence).toBe(0.7);
  });

  it('в запросе запрещено предсказывать исход', async () => {
    fetch.mockResolvedValue(reply({ approve: true, confidence: 0.5, reason: 'x' }));
    await judgeSignal(signal, context);

    const prompt = JSON.parse(fetch.mock.calls[0][1].body).contents[0].parts[0].text;
    expect(prompt).toContain('Не предсказывай исход');
  });
});

describe('measureLlmValue', () => {
  const trade = (approve, pnl) => ({
    status: 'closed', pnlMoney: pnl, llmVerdict: { approve },
  });

  it('без оценённых сделок ничего не считает', () => {
    expect(measureLlmValue([{ status: 'closed', pnlMoney: 100 }])).toBeNull();
  });

  it('сравнивает одобренные с отклонёнными', () => {
    const result = measureLlmValue([
      trade(true, 200), trade(true, 150), trade(true, -50),
      trade(false, -100), trade(false, -80), trade(false, 30),
    ]);

    expect(result.approved.trades).toBe(3);
    expect(result.rejected.trades).toBe(3);
    expect(result.approved.pnlMoney).toBe(300);
    expect(result.rejected.pnlMoney).toBe(-150);
  });

  it('считает разницу профит-факторов', () => {
    // Положительная разница означает, что отбор модели что-то даёт.
    const result = measureLlmValue([
      trade(true, 200), trade(true, -50),
      trade(false, 50), trade(false, -200),
    ]);

    expect(result.edge).toBeGreaterThan(0);
  });

  it('видит бесполезный отбор', () => {
    // Одинаковый результат в обеих группах: модель не добавляет ничего.
    const result = measureLlmValue([
      trade(true, 100), trade(true, -100),
      trade(false, 100), trade(false, -100),
    ]);

    expect(result.edge).toBe(0);
  });

  it('учитывает только закрытые сделки с вердиктом', () => {
    const result = measureLlmValue([
      trade(true, 100),
      { status: 'open', llmVerdict: { approve: true } },
      { status: 'closed', pnlMoney: 50 },
    ]);

    expect(result.judged).toBe(1);
  });
});

describe('выбор пути к модели', () => {
  it('свой ключ Google — основной путь', async () => {
    vi.stubEnv('GOOGLE_AI_KEY', 'own-key');
    const { getLlmConfig } = await import('../lib/config.js');

    const config = getLlmConfig();
    expect(config.via).toBe('google');
    expect(config.baseUrl).toContain('generativelanguage.googleapis.com');
  });

  it('без своего ключа используется шлюз Netlify', async () => {
    // Netlify подставляет GEMINI_API_KEY сам — это служебный токен
    // шлюза, а не ключ Google, и адрес у него другой.
    vi.stubEnv('GOOGLE_AI_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', 'gateway-token');
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', 'https://gateway.netlify/gemini');
    const { getLlmConfig } = await import('../lib/config.js');

    const config = getLlmConfig();
    expect(config.via).toBe('netlify-gateway');
    expect(config.baseUrl).toBe('https://gateway.netlify/gemini');
  });

  it('один GEMINI_API_KEY без адреса шлюза за настройку не считается', async () => {
    // Иначе служебный токен Netlify ушёл бы в Google напрямую.
    vi.stubEnv('GOOGLE_AI_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', 'gateway-token');
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', '');
    const { hasLlm } = await import('../lib/config.js');

    expect(hasLlm()).toBe(false);
  });

  it('без ключей слой считается ненастроенным', async () => {
    vi.stubEnv('GOOGLE_AI_KEY', '');
    vi.stubEnv('GEMINI_API_KEY', '');
    vi.stubEnv('GOOGLE_GEMINI_BASE_URL', '');
    const { hasLlm } = await import('../lib/config.js');

    expect(hasLlm()).toBe(false);
  });
});
