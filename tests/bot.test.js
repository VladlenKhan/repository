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

/** Обычное текстовое сообщение — так приходит нажатие кнопки клавиатуры. */
function textUpdate(text) {
  return {
    update_id: Math.floor(Math.random() * 1e6),
    message: {
      message_id: 1,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 42, type: 'private' },
      from: { id: 42, is_bot: false, first_name: 'Влад' },
      text,
    },
  };
}

/** Апдейт нажатия инлайн-кнопки. */
function callbackUpdate(data) {
  return {
    update_id: Math.floor(Math.random() * 1e6),
    callback_query: {
      id: String(Math.random()),
      from: { id: 42, is_bot: false, first_name: 'Влад' },
      chat_instance: '1',
      data,
      message: {
        message_id: 10,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 42, type: 'private' },
        from: { id: 1, is_bot: true, first_name: 'XAU' },
        text: 'предыдущее сообщение',
      },
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
const lastText = () => sent.filter((c) => c.payload?.text).at(-1)?.payload?.text ?? '';

/** Последний исходящий вызов. */
const lastSent = () => sent.at(-1);

/** Все отправленные тексты одной строкой — когда ответов несколько. */
const allText = () => sent.map((c) => c.payload?.text ?? '').join('\n');

describe('/start', () => {
  it('здоровается и сразу предлагает регистрацию', async () => {
    await bot.handleUpdate(commandUpdate('/start'));
    expect(allText()).toContain('Добро пожаловать');
    expect(allText()).toContain('автоматически');
  });

  it('отвечает на языке пользователя', async () => {
    settings.lang = 'en';
    await bot.handleUpdate(commandUpdate('/start'));
    expect(allText()).toContain('Welcome to Aurum');
  });

  it('предлагает открыть приложение первой кнопкой', async () => {
    vi.stubEnv('URL', 'https://example.netlify.app');
    await bot.handleUpdate(commandUpdate('/start'));

    const reply = sent.find((c) => c.method === 'sendMessage');
    const markup = JSON.stringify(reply.payload.reply_markup);
    expect(markup).toContain('web_app');
    expect(markup).toContain('Открыть приложение');
  });
});

describe('кнопка веб-версии', () => {
  beforeEach(() => vi.stubEnv('URL', 'https://example.netlify.app'));

  it('/start ставит кнопку меню в чате', async () => {
    // Глобальная установка Telegram не применяется — её перекрывает
    // настройка из BotFather, поэтому кнопка ставится каждому чату.
    await bot.handleUpdate(commandUpdate('/start'));

    const call = sent.find((c) => c.method === 'setChatMenuButton');
    expect(call).toBeDefined();
    expect(call.payload.chat_id).toBe(42);
    expect(call.payload.menu_button.type).toBe('web_app');
    expect(call.payload.menu_button.web_app.url).toContain('example.netlify.app');
  });

  it('/start добавляет инлайн-кнопку веб-версии', async () => {
    await bot.handleUpdate(commandUpdate('/start'));

    const reply = sent.find((c) => c.method === 'sendMessage');
    expect(JSON.stringify(reply.payload.reply_markup)).toContain('web_app');
  });

  it('/app присылает кнопку', async () => {
    await bot.handleUpdate(commandUpdate('/app'));
    expect(JSON.stringify(lastSent().payload.reply_markup)).toContain('web_app');
  });

  it('без заданного адреса сайта бот не падает', async () => {
    vi.stubEnv('URL', '');
    await bot.handleUpdate(commandUpdate('/start'));

    // Приветствие всё равно отправлено, просто без кнопки приложения.
    expect(allText()).toContain('Добро пожаловать');
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
    await bot.handleUpdate(commandUpdate('/macro'));
    expect(lastText()).toContain('не настроена');

    // Остальные команды при этом обязаны продолжать работать.
    await bot.handleUpdate(commandUpdate('/start'));
    expect(allText()).toContain('Добро пожаловать');
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

describe('клавиатура над полем ввода', () => {
  beforeEach(() => vi.stubEnv('URL', 'https://example.netlify.app'));

  it('/start ставит клавиатуру с двумя кнопками', async () => {
    // Рядом со скрепкой Telegram даёт только один слот, поэтому вторая
    // кнопка живёт на клавиатуре над полем ввода.
    await bot.handleUpdate(commandUpdate('/start'));

    const withKeyboard = sent.find((c) => c.payload?.reply_markup?.keyboard);
    expect(withKeyboard).toBeDefined();

    const markup = JSON.stringify(withKeyboard.payload.reply_markup);
    expect(markup).toContain('Веб-версия');
    expect(markup).toContain('Меню');
    expect(markup).toContain('web_app');
  });

  it('клавиатура не исчезает после нажатия', async () => {
    await bot.handleUpdate(commandUpdate('/start'));

    const withKeyboard = sent.find((c) => c.payload?.reply_markup?.keyboard);
    expect(withKeyboard.payload.reply_markup.is_persistent).toBe(true);
    expect(withKeyboard.payload.reply_markup.resize_keyboard).toBe(true);
  });

  it('нажатие кнопки «Меню» открывает меню', async () => {
    // Нажатие приходит обычным текстовым сообщением.
    await bot.handleUpdate(textUpdate('☰ Меню'));
    expect(lastText()).toContain('Что показать');
  });

  it('кнопка «Меню» работает и на английской подписи', async () => {
    // Человек мог сменить язык после того, как клавиатура появилась.
    await bot.handleUpdate(textUpdate('☰ Menu'));
    expect(lastText()).toContain('Что показать');
  });

  it('обычный текст без команды остаётся без ответа', async () => {
    await bot.handleUpdate(textUpdate('привет'));
    expect(sent).toHaveLength(0);
  });

  it('без адреса сайта остаётся одна кнопка меню', async () => {
    vi.stubEnv('URL', '');
    await bot.handleUpdate(commandUpdate('/start'));

    const withKeyboard = sent.find((c) => c.payload?.reply_markup?.keyboard);
    const markup = JSON.stringify(withKeyboard.payload.reply_markup);
    expect(markup).toContain('Меню');
    expect(markup).not.toContain('web_app');
  });
});

describe('инлайн-меню', () => {
  beforeEach(() => {
    vi.stubEnv('URL', 'https://example.netlify.app');
    vi.stubEnv('FRED_API_KEY', 'fred');
    fetch.mockImplementation(async (url) => {
      if (url.toString().includes('stlouisfed')) {
        return { ok: true, status: 200, json: async () => ({ observations: [{ date: '2026-10-05', value: '2.9' }] }) };
      }
      return { ok: true, status: 200, json: async () => twelveDataPayload() };
    });
  });

  it('/menu показывает все кнопки', async () => {
    await bot.handleUpdate(commandUpdate('/menu'));

    const markup = JSON.stringify(sent.at(-1).payload.reply_markup);
    for (const action of ['go:analysis', 'go:levels', 'go:macro', 'go:alerts', 'go:subscribe', 'go:lang']) {
      expect(markup).toContain(action);
    }
    expect(markup).toContain('web_app');
  });

  it('нажатие кнопки сразу подтверждается Telegram', async () => {
    // Без answerCallbackQuery на кнопке бесконечно крутится индикатор.
    await bot.handleUpdate(callbackUpdate('go:levels'));
    expect(sent.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
  });

  it('нажатие редактирует сообщение, а не шлёт новое', async () => {
    // Иначе чат быстро забивается полотном ответов.
    await bot.handleUpdate(callbackUpdate('go:levels'));

    expect(sent.some((c) => c.method === 'editMessageText')).toBe(true);
    expect(sent.some((c) => c.method === 'sendMessage')).toBe(false);
  });

  it('кнопка анализа показывает разбор с выбором таймфрейма', async () => {
    await bot.handleUpdate(callbackUpdate('go:analysis'));

    const edit = sent.find((c) => c.method === 'editMessageText');
    expect(edit.payload.text).toContain('XAU/USD');
    expect(JSON.stringify(edit.payload.reply_markup)).toContain('tf:4h');
  });

  it('кнопка таймфрейма пересчитывает разбор', async () => {
    await bot.handleUpdate(callbackUpdate('tf:1day'));

    const edit = sent.find((c) => c.method === 'editMessageText');
    expect(edit.payload.text).toContain('1day');
  });

  it('кнопка подписки работает переключателем', async () => {
    storage.isSubscribed.mockResolvedValueOnce(false);
    await bot.handleUpdate(callbackUpdate('go:subscribe'));
    expect(storage.subscribe).toHaveBeenCalled();

    sent.length = 0;
    storage.isSubscribed.mockResolvedValueOnce(true);
    await bot.handleUpdate(callbackUpdate('go:subscribe'));
    expect(storage.unsubscribe).toHaveBeenCalled();
  });

  it('под ответами есть кнопка возврата в меню', async () => {
    await bot.handleUpdate(callbackUpdate('go:macro'));

    const edit = sent.find((c) => c.method === 'editMessageText');
    expect(JSON.stringify(edit.payload.reply_markup)).toContain('go:menu');
  });

  it('неизвестное действие не ломает бота', async () => {
    await bot.handleUpdate(callbackUpdate('go:чепуха'));
    expect(sent.some((c) => c.method === 'answerCallbackQuery')).toBe(true);
  });
});

describe('неизвестная команда', () => {
  it('подсказывает /help', async () => {
    await bot.handleUpdate(commandUpdate('/чтототакое'));
    expect(lastText()).toContain('/help');
  });
});

describe('адрес веб-приложения', () => {
  it('кнопка не появляется для не-HTTPS адреса', async () => {
    // Telegram принимает в кнопках веб-приложения только HTTPS,
    // а netlify dev локально подставляет http://localhost.
    vi.stubEnv('URL', 'http://localhost:8899');

    await bot.handleUpdate(commandUpdate('/start'));

    const reply = sent.find((c) => c.method === 'sendMessage');
    expect(reply).toBeDefined();
    expect(JSON.stringify(reply.payload.reply_markup)).not.toContain('web_app');
    expect(reply.payload.text).toContain('Добро пожаловать');
    expect(allText()).toContain('Добро пожаловать');
  });

  it('кнопка появляется для HTTPS', async () => {
    vi.stubEnv('URL', 'https://example.netlify.app');
    await bot.handleUpdate(commandUpdate('/start'));

    const reply = sent.find((c) => c.method === 'sendMessage');
    expect(JSON.stringify(reply.payload.reply_markup)).toContain('web_app');
  });

  it('лишний слэш в конце не ломает адрес', async () => {
    vi.stubEnv('URL', 'https://example.netlify.app/');
    await bot.handleUpdate(commandUpdate('/start'));

    const reply = sent.find((c) => c.method === 'sendMessage');
    expect(JSON.stringify(reply.payload.reply_markup)).toContain('https://example.netlify.app/"');
  });
});
