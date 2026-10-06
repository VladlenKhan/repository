import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Простое хранилище аккаунтов в памяти вместо Blobs. */
const accounts = new Map();

vi.mock('../lib/storage.js', () => ({
  getAccount: vi.fn(async (login) => accounts.get(login) ?? null),
  saveAccount: vi.fn(async (account) => {
    accounts.set(account.login, account);
    return true;
  }),
  listAccounts: vi.fn(async () =>
    [...accounts.values()].map(({ passwordHash, ...safe }) => safe),
  ),
  listUsers: vi.fn(async () => [{ chatId: 1, lang: 'ru', updatedAt: '2026-10-06T17:00:00Z' }]),
  listSubscribers: vi.fn(async () => [{ chatId: 1, lang: 'ru' }]),
  listAllAlerts: vi.fn(async () => [
    { chatId: 1, items: [{ id: 'a', price: 4200, direction: 'above', createdAt: '2026-10-06T17:42:00Z' }] },
  ]),
  pingStorage: vi.fn(async () => ({ ok: true })),
  getCachedCandles: vi.fn(async () => null),
  setCachedCandles: vi.fn(async () => undefined),
}));

vi.mock('../lib/telegram.js', () => ({
  createApi: () => ({
    getWebhookInfo: vi.fn(async () => ({ url: 'https://x/api/bot', pending_update_count: 0 })),
  }),
}));

const authFn = (await import('../netlify/functions/auth.mjs')).default;
const dataFn = (await import('../netlify/functions/data.mjs')).default;

const ADMIN_LOGIN = 'vlad';
const ADMIN_PASSWORD = 'админский-пароль-длинный';

const authRequest = (body) =>
  new Request('https://x/api/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const dataRequest = (token) =>
  new Request('https://x/api/data', {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });

/** Регистрирует пользователя и возвращает его токен. */
async function registerUser(login, password = 'пароль-пользователя') {
  const response = await authFn(authRequest({ action: 'register', login, password }));
  return (await response.json()).token;
}

/** Входит админом и возвращает токен. */
async function loginAdmin() {
  const response = await authFn(
    authRequest({ action: 'login', login: ADMIN_LOGIN, password: ADMIN_PASSWORD }),
  );
  return (await response.json()).token;
}

beforeEach(() => {
  accounts.clear();
  vi.stubEnv('SESSION_SECRET', 'секрет-подписи');
  vi.stubEnv('ADMIN_LOGIN', ADMIN_LOGIN);
  vi.stubEnv('ADMIN_PASSWORD', ADMIN_PASSWORD);
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

describe('регистрация', () => {
  it('создаёт аккаунт с ролью пользователя', async () => {
    const response = await authFn(authRequest({ action: 'register', login: 'vasya', password: 'пароль12345' }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.account.role).toBe('user');
    expect(body.token).toBeTruthy();
  });

  it('никогда не отдаёт хеш пароля наружу', async () => {
    const response = await authFn(authRequest({ action: 'register', login: 'vasya', password: 'пароль12345' }));
    expect(await response.text()).not.toContain('scrypt');
  });

  it('не даёт занять логин дважды', async () => {
    await registerUser('vasya');
    const response = await authFn(authRequest({ action: 'register', login: 'vasya', password: 'другой-пароль' }));

    expect(response.status).toBe(401);
    expect((await response.json()).error).toContain('занят');
  });

  it('не даёт зарегистрироваться под админским логином', async () => {
    // Иначе первый желающий занял бы логин владельца и получил его права.
    const response = await authFn(
      authRequest({ action: 'register', login: ADMIN_LOGIN, password: 'своя-попытка' }),
    );
    expect(response.status).toBe(401);
  });

  it('отвергает короткий пароль', async () => {
    const response = await authFn(authRequest({ action: 'register', login: 'vasya', password: '1234' }));
    expect((await response.json()).error).toContain('восьми');
  });
});

describe('вход', () => {
  it('пускает пользователя с верным паролем', async () => {
    await registerUser('vasya', 'пароль-пользователя');
    const response = await authFn(
      authRequest({ action: 'login', login: 'vasya', password: 'пароль-пользователя' }),
    );
    expect(response.status).toBe(200);
  });

  it('не пускает с неверным паролем', async () => {
    await registerUser('vasya', 'пароль-пользователя');
    const response = await authFn(authRequest({ action: 'login', login: 'vasya', password: 'не тот' }));
    expect(response.status).toBe(401);
  });

  it('не выдаёт, существует ли логин', async () => {
    // Одинаковый текст ошибки не позволяет перебором собрать список логинов.
    await registerUser('vasya', 'пароль-пользователя');

    const wrongPassword = await authFn(authRequest({ action: 'login', login: 'vasya', password: 'не тот' }));
    const noSuchLogin = await authFn(authRequest({ action: 'login', login: 'нет-такого', password: 'не тот' }));

    expect((await wrongPassword.json()).error).toBe((await noSuchLogin.json()).error);
  });

  it('пускает админа по данным из окружения', async () => {
    const response = await authFn(
      authRequest({ action: 'login', login: ADMIN_LOGIN, password: ADMIN_PASSWORD }),
    );
    expect((await response.json()).account.role).toBe('admin');
  });

  it('логин админа нечувствителен к регистру', async () => {
    const response = await authFn(
      authRequest({ action: 'login', login: 'VLAD', password: ADMIN_PASSWORD }),
    );
    expect((await response.json()).account.role).toBe('admin');
  });
});

describe('вход через Telegram', () => {
  const ADMIN_TG = 1345915209;
  const BOT_TOKEN = '1:T';

  /** Подписывает данные так же, как Telegram. */
  function signInitData(user, token = BOT_TOKEN) {
    const fields = {
      auth_date: String(Math.floor(Date.now() / 1000)),
      user: JSON.stringify(user),
    };
    const pairs = Object.entries(fields).map(([k, v]) => `${k}=${v}`).sort();
    const secret = createHmac('sha256', 'WebAppData').update(token).digest();
    const hash = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
    return new URLSearchParams({ ...fields, hash }).toString();
  }

  beforeEach(() => {
    vi.stubEnv('ADMIN_TELEGRAM_ID', String(ADMIN_TG));
  });

  it('владелец получает роль администратора', async () => {
    const initData = signInitData({ id: ADMIN_TG, first_name: 'Влад', username: 'vlad' });
    const response = await authFn(authRequest({ action: 'telegram', initData }));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.account.role).toBe('admin');
  });

  it('остальные получают роль пользователя', async () => {
    const initData = signInitData({ id: 777, first_name: 'Вася' });
    const body = await (await authFn(authRequest({ action: 'telegram', initData }))).json();

    expect(body.account.role).toBe('user');
  });

  it('подмена Telegram ID на админский не проходит', async () => {
    // Главная атака: взять свои подписанные данные и заменить в них ID
    // на идентификатор владельца.
    const mine = signInitData({ id: 777, first_name: 'Вася' });
    const tampered = mine.replace('777', String(ADMIN_TG));

    const response = await authFn(authRequest({ action: 'telegram', initData: tampered }));
    expect(response.status).toBe(401);
  });

  it('данные, подписанные чужим токеном, не принимаются', async () => {
    const forged = signInitData({ id: ADMIN_TG, first_name: 'Влад' }, '999:ЧУЖОЙ');
    expect((await authFn(authRequest({ action: 'telegram', initData: forged }))).status).toBe(401);
  });

  it('повторный вход не плодит аккаунты и сохраняет дату регистрации', async () => {
    const initData = signInitData({ id: 777, first_name: 'Вася' });

    const first = await (await authFn(authRequest({ action: 'telegram', initData }))).json();
    await new Promise((r) => setTimeout(r, 5));
    const second = await (await authFn(authRequest({ action: 'telegram', initData }))).json();

    expect(accounts.size).toBe(1);
    expect(second.account.createdAt).toBe(first.account.createdAt);
  });

  it('у аккаунта из Telegram нет пароля', async () => {
    const initData = signInitData({ id: 777, first_name: 'Вася' });
    await authFn(authRequest({ action: 'telegram', initData }));

    expect(accounts.get('tg777').passwordHash).toBeUndefined();
  });
});

describe('доступ к данным по ролям', () => {
  it('гостю без токена отказано', async () => {
    const response = await dataFn(dataRequest());
    expect(response.status).toBe(401);
  });

  it('гостю с поддельным токеном отказано', async () => {
    // Токен всегда base64url, то есть латиница: в заголовок HTTP
    // кириллица не помещается в принципе.
    const response = await dataFn(dataRequest('cG9kZGVsa2E.cG9kcGlz'));
    expect(response.status).toBe(401);
  });

  it('пользователь видит рынок', async () => {
    const token = await registerUser('vasya');
    const body = await (await dataFn(dataRequest(token))).json();

    expect(body.role).toBe('user');
    expect(body).toHaveProperty('market');
  });

  it('пользователь НЕ видит чужих данных', async () => {
    const token = await registerUser('vasya');
    const body = await (await dataFn(dataRequest(token))).json();

    expect(body.users).toBeUndefined();
    expect(body.alerts).toBeUndefined();
    expect(body.accounts).toBeUndefined();
    expect(body.subscribers).toBeUndefined();
    expect(body.usage).toBeUndefined();
    expect(body.webhook).toBeUndefined();
  });

  it('чужие данные не уезжают в браузер пользователя даже в сыром виде', async () => {
    // Фильтрация должна быть на сервере, а не в разметке.
    const token = await registerUser('vasya');
    const raw = await (await dataFn(dataRequest(token))).text();

    expect(raw).not.toContain('chatId');
  });

  it('админ видит всё', async () => {
    await registerUser('vasya');
    const token = await loginAdmin();
    const body = await (await dataFn(dataRequest(token))).json();

    expect(body.role).toBe('admin');
    expect(body.users).toBeDefined();
    expect(body.alerts).toBeDefined();
    expect(body.accounts).toBeDefined();
    expect(body.storage).toBeDefined();
  });

  it('список аккаунтов не содержит хешей паролей', async () => {
    await registerUser('vasya');
    const token = await loginAdmin();
    const raw = await (await dataFn(dataRequest(token))).text();

    expect(raw).not.toContain('scrypt');
  });

  it('смена секрета подписи аннулирует выданные токены', async () => {
    const token = await registerUser('vasya');
    vi.stubEnv('SESSION_SECRET', 'новый-секрет');

    expect((await dataFn(dataRequest(token))).status).toBe(401);
  });
});
