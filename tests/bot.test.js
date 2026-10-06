import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Blobs вне Netlify недоступны — подменяем хранилище.
const settings = { lang: 'ru' };
vi.mock('../lib/storage.js', () => ({
  getUserSettings: vi.fn(async () => settings),
  saveUserSettings: vi.fn(async () => true),
  getCachedCandles: vi.fn(async () => null),
  setCachedCandles: vi.fn(async () => undefined),
  isSubscribed: vi.fn(async () => false),
  subscribe: vi.fn(async () => true),
  unsubscribe: vi.fn(async () => true),
  getAlerts: vi.fn(async () => []),
  saveAlerts: vi.fn(async () => true),
  listAllAlerts: vi.fn(async () => []),
}));

const storage = await import('../lib/storage.js');

const { createBot } = await import('../lib/bot.js');

/**
 * Собирает апдейт так, как его присылает Telegram.
 *
 * Ключевой момент: grammY распознаёт команды по entities, а не по тексту.
 * Без entities сообщение «/analysis» для бота — просто текст, и команда
 * не сработает. Поэтому entity обязателен.
 */
function commandUpdate(text) {
  const command = text.split(' ')[0];
  return {
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: 'private' },
      from: { id: 42, is_bot: false, first_name: 'Влад' },
      text,
      entities: [{ offset: 0, length: command.length, type: 'bot_command' }],
    },
  };
}

/** Свечи Twelve Data: от новых к старым, как отдаёт настоящий API. */
function twelveDataPayload(count = 300) {
  const values = Array.from({ length: count }, (_, i) => {
    const close = 2600 + i * 0.4;
    return {
      datetime: `2026-10-06 ${String(i % 24).padStart(2, '0')}:00:00`,
      open: String(close),
      high: String(close + 4),
      low: String(close - 4),
      close: String(close),
      volume: '100',
    };
  }).reverse();
  return { status: 'ok', values };
}

let bot;
let sent;

beforeEach(async () => {
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '111:TEST');
  vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 'secret');
  vi.stubEnv('TWELVE_DATA_API_KEY', 'test-key');
  // botInfo избавляет от обращения к getMe при инициализации.
  vi.stubEnv(
    'TELEGRAM_BOT_INFO',
    JSON.stringify({
      id: 111,
      is_bot: true,
      first_name: 'XAU',
      username: 'xau_test_bot',
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    }),
  );

  sent = [];
  bot = createBot();

  // Перехватываем исходящие вызовы Telegram вместо сетевых запросов.
  bot.api.config.use(async (_prev, method, payload) => {
    sent.push({ method, payload });
    return { ok: true, result: { message_id: 1 } };
  });

  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  settings.lang = 'ru';
});

/** Последний текст, отправленный ботом. */
const lastText = () => sent.at(-1)?.payload?.text ?? '';

describe('/start', () => {
  it('здоровается и показывает список команд', async () => {
    await bot.handleUpdate(commandUpdate('/start'));
    expect(lastText()).toContain('Влад');
    expect(lastText()).toContain('/analysis');
  });

  it('отвечает на языке пользователя', async () => {
    settings.lang = 'en';
    await bot.handleUpdate(commandUpdate('/start'));
    expect(lastText()).toContain('market breakdown');
  });
});

describe('/analysis', () => {
  it('присылает разбор рынка', async () => {
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => twelveDataPayload() });

    await bot.handleUpdate(commandUpdate('/analysis 4h'));

    const text = lastText();
    expect(text).toContain('XAU/USD');
    expect(text).toContain('4h');
    expect(text).toContain('RSI(14)');
    expect(text).toContain('ATR(14)');
    expect(text).toContain('Это не финансовая рекомендация');
  });

  it('по умолчанию берёт часовой таймфрейм', async () => {
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => twelveDataPayload() });

    await bot.handleUpdate(commandUpdate('/analysis'));

    expect(fetch.mock.calls[0][0].toString()).toContain('interval=1h');
  });

  it('объясняет, что таймфрейм неизвестен, и не идёт в сеть', async () => {
    await bot.handleUpdate(commandUpdate('/analysis 3h'));

    expect(lastText()).toContain('Не знаю такой таймфрейм');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('понятно сообщает об исчерпанном лимите API', async () => {
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ status: 'error', code: 429, message: 'out of credits' }),
    });

    await bot.handleUpdate(commandUpdate('/analysis'));

    expect(lastText()).toContain('Лимит запросов');
  });

  it('понятно сообщает о недоступности поставщика данных', async () => {
    fetch.mockRejectedValue(new Error('network down'));

    await bot.handleUpdate(commandUpdate('/analysis'));

    expect(lastText()).toContain('не отвечает');
  });
});

describe('/levels', () => {
  it('показывает уровни D1 и H4', async () => {
    fetch.mockResolvedValue({ ok: true, status: 200, json: async () => twelveDataPayload(5) });

    await bot.handleUpdate(commandUpdate('/levels'));

    const text = lastText();
    expect(text).toContain('D1');
    expect(text).toContain('H4');
    expect(text).toContain('PP');
    expect(text).toContain('R1');
    expect(text).toContain('S1');
    expect(text).toContain('Это не финансовая рекомендация');
  });

  it('запрашивает оба таймфрейма параллельно, а не по очереди', async () => {
    let active = 0;
    let maxActive = 0;
    fetch.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
      return { ok: true, status: 200, json: async () => twelveDataPayload(5) };
    });

    await bot.handleUpdate(commandUpdate('/levels'));

    // Оба запроса должны быть в полёте одновременно.
    expect(maxActive).toBe(2);
  });

  it('сообщает о сбое поставщика данных понятным текстом', async () => {
    fetch.mockRejectedValue(new Error('network down'));
    await bot.handleUpdate(commandUpdate('/levels'));
    expect(lastText()).toContain('не отвечает');
  });
});

describe('/macro', () => {
  it('показывает реальную доходность и комментарий', async () => {
    vi.stubEnv('FRED_API_KEY', 'fred-key');
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        observations: [
          { date: '2026-10-05', value: '1.92' },
          { date: '2026-10-04', value: '1.80' },
        ],
      }),
    });

    await bot.handleUpdate(commandUpdate('/macro'));

    const text = lastText();
    expect(text).toContain('DFII10');
    expect(text).toContain('1.92');
    expect(text).toContain('+0.12');
    expect(text).toContain('растёт');
    expect(text).toContain('Это не финансовая рекомендация');
  });

  it('объясняет отрицательную доходность отдельно', async () => {
    vi.stubEnv('FRED_API_KEY', 'fred-key');
    fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ observations: [{ date: '2026-10-05', value: '-0.35' }] }),
    });

    await bot.handleUpdate(commandUpdate('/macro'));
    expect(lastText()).toContain('отрицательная');
  });

  it('сообщает о недоступности FRED', async () => {
    vi.stubEnv('FRED_API_KEY', 'fred-key');
    fetch.mockRejectedValue(new Error('network down'));

    await bot.handleUpdate(commandUpdate('/macro'));
    expect(lastText()).toContain('FRED');
  });

  it('прямо сообщает, что ключ FRED не настроен', async () => {
    // Остальные команды при этом обязаны продолжать работать.
    await bot.handleUpdate(commandUpdate('/macro'));
    expect(lastText()).toContain('не настроена');

    await bot.handleUpdate(commandUpdate('/start'));
    expect(lastText()).toContain('Влад');
  });
});

describe('подписка', () => {
  it('оформляет подписку', async () => {
    storage.isSubscribed.mockResolvedValueOnce(false);
    await bot.handleUpdate(commandUpdate('/subscribe'));

    expect(storage.subscribe).toHaveBeenCalledWith(42, 'ru');
    expect(lastText()).toContain('Подписка оформлена');
  });

  it('не дублирует существующую подписку', async () => {
    storage.isSubscribed.mockResolvedValueOnce(true);
    await bot.handleUpdate(commandUpdate('/subscribe'));

    expect(storage.subscribe).not.toHaveBeenCalled();
    expect(lastText()).toContain('уже подписаны');
  });

  it('отписывает', async () => {
    storage.isSubscribed.mockResolvedValueOnce(true);
    await bot.handleUpdate(commandUpdate('/unsubscribe'));

    expect(storage.unsubscribe).toHaveBeenCalledWith(42);
    expect(lastText()).toContain('отменена');
  });

  it('спокойно реагирует на отписку без подписки', async () => {
    storage.isSubscribed.mockResolvedValueOnce(false);
    await bot.handleUpdate(commandUpdate('/unsubscribe'));

    expect(storage.unsubscribe).not.toHaveBeenCalled();
    expect(lastText()).toContain('не подписаны');
  });
});

describe('/alert', () => {
  const quote = (price) => ({ ok: true, status: 200, json: async () => ({ price: String(price) }) });

  it('создаёт уведомление и определяет направление', async () => {
    fetch.mockResolvedValue(quote(2350));
    await bot.handleUpdate(commandUpdate('/alert 2400'));

    expect(lastText()).toContain('вверх');
    expect(lastText()).toContain('2400');
    expect(storage.saveAlerts).toHaveBeenCalledWith(42, [
      expect.objectContaining({ price: 2400, direction: 'above' }),
    ]);
  });

  it('определяет направление вниз', async () => {
    fetch.mockResolvedValue(quote(2450));
    await bot.handleUpdate(commandUpdate('/alert 2400'));
    expect(lastText()).toContain('вниз');
  });

  it('подсказывает формат без аргумента', async () => {
    await bot.handleUpdate(commandUpdate('/alert'));

    expect(lastText()).toContain('/alert 4200');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('отвергает мусор вместо цены, не тратя запрос', async () => {
    await bot.handleUpdate(commandUpdate('/alert дорого'));

    expect(lastText()).toContain('Не похоже на цену');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('показывает список уведомлений', async () => {
    storage.getAlerts.mockResolvedValueOnce([
      { id: 'a', price: 2400, direction: 'above' },
      { id: 'b', price: 2300, direction: 'below' },
    ]);

    await bot.handleUpdate(commandUpdate('/alerts'));

    expect(lastText()).toContain('2400');
    expect(lastText()).toContain('2300');
    expect(lastText()).toContain('срабатывает один раз');
  });

  it('сообщает о пустом списке', async () => {
    storage.getAlerts.mockResolvedValueOnce([]);
    await bot.handleUpdate(commandUpdate('/alerts'));
    expect(lastText()).toContain('Активных уведомлений нет');
  });

  it('очищает список', async () => {
    await bot.handleUpdate(commandUpdate('/alerts_clear'));

    expect(storage.saveAlerts).toHaveBeenCalledWith(42, []);
    expect(lastText()).toContain('удалены');
  });
});

describe('обязательная оговорка', () => {
  const DISCLAIMER = 'Это не финансовая рекомендация';

  beforeEach(() => {
    vi.stubEnv('FRED_API_KEY', 'fred-key');
    fetch.mockImplementation(async (url) => {
      const href = url.toString();
      if (href.includes('stlouisfed')) {
        return {
          ok: true, status: 200,
          json: async () => ({ observations: [{ date: '2026-10-05', value: '1.92' }] }),
        };
      }
      return { ok: true, status: 200, json: async () => twelveDataPayload() };
    });
  });

  it.each(['/analysis', '/levels', '/macro'])('есть в ответе %s', async (command) => {
    await bot.handleUpdate(commandUpdate(command));
    expect(lastText()).toContain(DISCLAIMER);
  });

  it.each(['/start', '/help', '/alerts'])('нет в служебном ответе %s', async (command) => {
    // Оговорка обязательна для сообщений с анализом. В служебных ответах
    // она была бы шумом и со временем перестала бы читаться.
    await bot.handleUpdate(commandUpdate(command));
    expect(lastText()).not.toContain(DISCLAIMER);
  });
});

describe('обработка ошибок', () => {
  it('на одну команду отправляет ровно одно сообщение об ошибке', async () => {
    // Регрессия: раньше ответ уходил до проверки типа ошибки, поэтому
    // чужая ошибка давала пользователю два сообщения подряд.
    vi.stubEnv('TWELVE_DATA_API_KEY', '');

    await bot.handleUpdate(commandUpdate('/analysis'));

    expect(sent).toHaveLength(1);
    expect(lastText()).toContain('не настроена');
  });

  it('то же самое для /levels', async () => {
    vi.stubEnv('TWELVE_DATA_API_KEY', '');

    await bot.handleUpdate(commandUpdate('/levels'));

    expect(sent).toHaveLength(1);
    expect(lastText()).toContain('не настроена');
  });

  it('то же самое для /alert', async () => {
    vi.stubEnv('TWELVE_DATA_API_KEY', '');

    await bot.handleUpdate(commandUpdate('/alert 2400'));

    expect(sent).toHaveLength(1);
    expect(lastText()).toContain('не настроена');
  });

  it('сбой поставщика данных по-прежнему даёт одно понятное сообщение', async () => {
    fetch.mockRejectedValue(new Error('network down'));

    await bot.handleUpdate(commandUpdate('/analysis'));

    expect(sent).toHaveLength(1);
    expect(lastText()).toContain('не отвечает');
  });
});

describe('неизвестная команда', () => {
  it('подсказывает /help', async () => {
    await bot.handleUpdate(commandUpdate('/чтототакое'));
    expect(lastText()).toContain('/help');
  });
});
