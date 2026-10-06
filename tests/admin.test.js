import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/storage.js', () => ({
  listUsers: vi.fn(async () => [{ chatId: 1, lang: 'ru', updatedAt: '2026-10-06T17:00:00Z' }]),
  listSubscribers: vi.fn(async () => [{ chatId: 1, lang: 'ru' }]),
  listAllAlerts: vi.fn(async () => []),
  pingStorage: vi.fn(async () => ({ ok: true })),
  getCachedCandles: vi.fn(async () => null),
  setCachedCandles: vi.fn(async () => undefined),
}));

vi.mock('../lib/telegram.js', () => ({
  createApi: () => ({
    getWebhookInfo: vi.fn(async () => ({
      url: 'https://example.netlify.app/api/bot',
      pending_update_count: 0,
    })),
  }),
}));

const { flattenAlerts } = await import('../lib/admin.js');
const adminFn = (await import('../netlify/functions/admin.mjs')).default;

const PASSWORD = 'правильный-пароль-длинный';

/** Запрос с паролем в теле — так его шлёт панель. */
function request(password) {
  return new Request('https://example.app/api/admin', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(password === undefined ? {} : { password }),
  });
}

/** Запрос с паролем в заголовке — запасной путь для curl. */
function headerRequest(auth) {
  return new Request('https://example.app/api/admin', {
    headers: { authorization: auth },
  });
}

beforeEach(() => {
  vi.stubEnv('ADMIN_PASSWORD', PASSWORD);
  vi.stubEnv('TWELVE_DATA_API_KEY', 'key');
  vi.stubEnv('FRED_API_KEY', 'fred');
  vi.stubEnv('TELEGRAM_BOT_TOKEN', '1:T');
  vi.stubEnv('TELEGRAM_WEBHOOK_SECRET', 's');
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('доступ к панели', () => {
  it('без пароля отвечает 401', async () => {
    const response = await adminFn(request());
    expect(response.status).toBe(401);
  });

  it('с неверным паролем отвечает 401', async () => {
    const response = await adminFn(request('неверный'));
    expect(response.status).toBe(401);
  });

  it('пароль другой длины не проходит', async () => {
    // Проверка выполняется за постоянное время, но результат должен
    // оставаться правильным и для строк разной длины.
    const response = await adminFn(request(PASSWORD + 'хвост'));
    expect(response.status).toBe(401);
  });

  it('принимает пароль и через заголовок — для проверки из curl', async () => {
    // В заголовок помещается только латиница, поэтому пароль здесь ASCII.
    vi.stubEnv('ADMIN_PASSWORD', 'ascii-password-123');
    const response = await adminFn(headerRequest('Bearer ascii-password-123'));
    expect(response.status).toBe(200);
  });

  it('заголовок без схемы Bearer не принимается', async () => {
    vi.stubEnv('ADMIN_PASSWORD', 'ascii-password-123');
    const response = await adminFn(headerRequest('ascii-password-123'));
    expect(response.status).toBe(401);
  });

  it('работает с паролем на кириллице', async () => {
    // Заголовки HTTP такой пароль не пропустили бы, тело — пропускает.
    vi.stubEnv('ADMIN_PASSWORD', 'пароль-на-кириллице');
    const response = await adminFn(request('пароль-на-кириллице'));
    expect(response.status).toBe(200);
  });

  it('не выдаёт данные вместе с ошибкой 401', async () => {
    const body = await (await adminFn(request('нет'))).json();
    expect(body.users).toBeUndefined();
    expect(body.alerts).toBeUndefined();
    expect(Object.keys(body)).toEqual(['error']);
  });

  it('с верным паролем отдаёт данные', async () => {
    const response = await adminFn(request(PASSWORD));
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.users).toHaveLength(1);
    expect(body.storage.ok).toBe(true);
  });

  it('запрещает кэширование ответа', async () => {
    // Иначе данные пользователей осели бы в кэше браузера или CDN.
    const response = await adminFn(request(PASSWORD));
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('без заданного ADMIN_PASSWORD панель не поднимается', async () => {
    vi.stubEnv('ADMIN_PASSWORD', '');
    const response = await adminFn(request('что-угодно'));

    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain('не настроена');
  });
});

describe('устойчивость к отказам разделов', () => {
  it('отдаёт данные, даже если часть источников недоступна', async () => {
    fetch.mockRejectedValue(new Error('сеть недоступна'));

    const response = await adminFn(request(PASSWORD));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.users).toHaveLength(1);        // этот раздел жив
    expect(body.errors.length).toBeGreaterThan(0); // а про упавшие честно сказано
  });
});

describe('flattenAlerts', () => {
  const chats = [
    { chatId: 1, items: [{ id: 'a', price: 4300, direction: 'above' }] },
    { chatId: 2, items: [{ id: 'b', price: 4180, direction: 'above' }] },
    { chatId: 2, items: [{ id: 'c', price: 4000, direction: 'below' }] },
  ];

  it('разворачивает алерты всех чатов в один список', () => {
    expect(flattenAlerts(chats, 4160)).toHaveLength(3);
  });

  it('считает расстояние до цели', () => {
    const rows = flattenAlerts([chats[0]], 4160);
    expect(rows[0].distance).toBe(140);
    expect(rows[0].distancePercent).toBeCloseTo(3.37, 1);
  });

  it('ставит ближайшие к срабатыванию наверх', () => {
    const rows = flattenAlerts(chats, 4160);
    expect(rows[0].price).toBe(4180); // 20 пунктов
    expect(rows.at(-1).price).toBe(4000); // 160 пунктов
  });

  it('не падает, если цена неизвестна', () => {
    const rows = flattenAlerts(chats, null);
    expect(rows[0].distance).toBeNull();
    expect(rows[0].distancePercent).toBeNull();
  });
});
