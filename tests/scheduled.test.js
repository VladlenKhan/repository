import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent = [];

vi.mock('../lib/storage.js', () => ({
  getUserSettings: vi.fn(async () => ({ lang: 'ru' })),
  listSubscribers: vi.fn(async () => []),
  unsubscribe: vi.fn(async () => true),
  listAllAlerts: vi.fn(async () => []),
  saveAlerts: vi.fn(async () => true),
  getAlerts: vi.fn(async () => []),
  getCachedCandles: vi.fn(async () => null),
  setCachedCandles: vi.fn(async () => undefined),
}));

// Подменяем только отправку: вся остальная логика grammY не нужна.
vi.mock('../lib/telegram.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    createApi: () => ({
      sendMessage: vi.fn(async (chatId, text) => {
        sent.push({ chatId, text });
        return { message_id: 1 };
      }),
    }),
  };
});

const storage = await import('../lib/storage.js');
const alertsFn = (await import('../netlify/functions/alerts.mjs')).default;
const morningFn = (await import('../netlify/functions/morning.mjs')).default;

function twelveDataPayload(count = 300) {
  const values = Array.from({ length: count }, (_, i) => {
    const close = 2600 + i * 0.4;
    return {
      datetime: `2026-10-06 ${String(i % 24).padStart(2, '0')}:00:00`,
      open: String(close), high: String(close + 4),
      low: String(close - 4), close: String(close), volume: '100',
    };
  }).reverse();
  return { status: 'ok', values };
}

beforeEach(() => {
  sent.length = 0;
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '111:TEST');
  vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'secret');
  vi.stubEnv('TWELVE_DATA_API_KEY', 'test-key');
  vi.stubGlobal('fetch', vi.fn());
  // Среда, 12:00 UTC — рынок открыт.
  vi.setSystemTime(new Date('2026-10-07T12:00:00Z'));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('функция проверки алертов', () => {
  it('пропускает запуск в выходные, не тратя кредиты API', async () => {
    vi.setSystemTime(new Date('2026-10-10T12:00:00Z')); // суббота

    const response = await alertsFn();

    expect(await response.text()).toContain('market closed');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('уведомляет чат при достижении уровня', async () => {
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ price: '2450.00' }) });
    storage.listAllAlerts.mockResolvedValueOnce([
      { chatId: 42, items: [{ id: 'a', price: 2400, direction: 'above' }] },
    ]);

    await alertsFn();

    expect(sent).toHaveLength(1);
    expect(sent[0].chatId).toBe(42);
    expect(sent[0].text).toContain('2400');
  });

  it('молчит, когда ни один уровень не достигнут', async () => {
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ price: '2350.00' }) });
    storage.listAllAlerts.mockResolvedValueOnce([
      { chatId: 42, items: [{ id: 'a', price: 2400, direction: 'above' }] },
    ]);

    await alertsFn();
    expect(sent).toHaveLength(0);
  });

  it('не падает, если поставщик цен недоступен', async () => {
    fetch.mockRejectedValue(new Error('network down'));

    const response = await alertsFn();

    // Ответ должен быть обычным, иначе Netlify сочтёт запуск неуспешным.
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('skipped');
  });
});

describe('функция утренней сводки', () => {
  it('ничего не делает без подписчиков', async () => {
    storage.listSubscribers.mockResolvedValueOnce([]);

    const response = await morningFn();

    expect(await response.text()).toBe('no subscribers');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('рассылает сводку всем подписчикам', async () => {
    storage.listSubscribers.mockResolvedValueOnce([
      { chatId: 1, lang: 'ru' },
      { chatId: 2, lang: 'en' },
    ]);
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => twelveDataPayload() });

    await morningFn();

    expect(sent).toHaveLength(2);
    expect(sent[0].text).toContain('Утренняя сводка');
    expect(sent[1].text).toContain('Morning gold summary');
  });

  it('запрашивает рынок один раз на всю рассылку', async () => {
    storage.listSubscribers.mockResolvedValueOnce([
      { chatId: 1, lang: 'ru' },
      { chatId: 2, lang: 'ru' },
      { chatId: 3, lang: 'ru' },
    ]);
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => twelveDataPayload() });

    await morningFn();

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('не падает, если данные получить не удалось', async () => {
    storage.listSubscribers.mockResolvedValueOnce([{ chatId: 1, lang: 'ru' }]);
    fetch.mockRejectedValue(new Error('network down'));

    const response = await morningFn();

    expect(response.status).toBe(200);
    expect(sent).toHaveLength(0);
  });

  it('каждое сообщение заканчивается обязательной оговоркой', async () => {
    storage.listSubscribers.mockResolvedValueOnce([{ chatId: 1, lang: 'ru' }]);
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => twelveDataPayload() });

    await morningFn();

    expect(sent[0].text).toContain('Это не финансовая рекомендация');
  });
});
