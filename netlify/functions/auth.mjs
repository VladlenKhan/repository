/**
 * Регистрация и вход.
 *
 * POST /api/auth  { action: 'register' | 'login', login, password }
 * Ответ: { token, account } или { error }
 */
import { login as doLogin, register as doRegister } from '../../lib/accounts.js';
import { ConfigError } from '../../lib/config.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export default async (request) => {
  if (request.method !== 'POST') {
    return json({ error: 'Метод не поддерживается' }, 405);
  }

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Некорректный запрос' }, 400);

  try {
    const result =
      body.action === 'register'
        ? await doRegister(body.login, body.password)
        : await doLogin(body.login, body.password);

    if (!result.ok) {
      // Задержка замедляет перебор логинов и паролей.
      await new Promise((resolve) => setTimeout(resolve, 500));
      return json({ error: result.reason }, 401);
    }

    return json({ token: result.token, account: result.account });
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error('[auth] не настроено:', error.message);
      return json({ error: 'Вход временно недоступен' }, 503);
    }
    console.error('[auth] сбой:', error);
    return json({ error: 'Не удалось обработать запрос' }, 500);
  }
};

export const config = { path: '/api/auth' };
