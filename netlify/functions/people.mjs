/**
 * Управление людьми. Доступно только владельцу.
 *
 * POST /api/people  { login, role }              — сменить роль
 * POST /api/people  { action:'delete', telegramId } — удалить целиком
 *
 * Администратору сюда нельзя: иначе он мог бы повысить себя или
 * удалить других администраторов.
 */
import { removePerson, setRole } from '../../lib/accounts.js';
import { ROLES, verifyToken } from '../../lib/auth.js';
import { ConfigError, getSessionSecret } from '../../lib/config.js';

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

function extractToken(request) {
  const match = (request.headers.get('authorization') ?? '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export default async (request) => {
  if (request.method !== 'POST') return json({ error: 'Метод не поддерживается' }, 405);

  let secret;
  try {
    secret = getSessionSecret();
  } catch (error) {
    if (error instanceof ConfigError) return json({ error: 'Сервис не настроен' }, 503);
    throw error;
  }

  const session = verifyToken(extractToken(request), secret);
  if (!session) return json({ error: 'Нужно войти' }, 401);

  // Назначать роли может только владелец — не администратор.
  // Иначе админ мог бы повысить себя или понизить других админов.
  if (session.role !== ROLES.OWNER) {
    return json({ error: 'Недостаточно прав' }, 403);
  }

  const body = await request.json().catch(() => null);
  if (!body) return json({ error: 'Некорректный запрос' }, 400);

  if (body.action === 'delete') {
    const result = await removePerson(body.telegramId);
    if (!result.ok) return json({ error: result.reason }, 400);
    return json({ ok: true, removed: result.removed });
  }

  if (!body.login || !body.role) return json({ error: 'Некорректный запрос' }, 400);

  const result = await setRole(body.login, body.role);
  if (!result.ok) return json({ error: result.reason }, 400);

  return json({ account: result.account });
};

export const config = { path: '/api/people' };
