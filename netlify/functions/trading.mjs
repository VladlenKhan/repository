/**
 * Журнал бумажных сделок и его настройки.
 *
 * GET  /api/trading            — журнал, статистика, настройки
 * POST /api/trading  {settings} — сохранить настройки (только владелец)
 * POST /api/trading  {action:'reset'} — очистить журнал (только владелец)
 *
 * Читать может любой вошедший: это не персональные данные, а результат
 * работы системы. Менять — только владелец.
 */
import { ROLES, verifyToken } from '../../lib/auth.js';
import { ConfigError, getSessionSecret } from '../../lib/config.js';
import { getPositions, getTradingSettings, savePositions, saveTradingSettings } from '../../lib/storage.js';
import { STRATEGIES } from '../../lib/strategies.js';
import { floatingPnl, normalizeSettings, summarize } from '../../lib/trading.js';
import { measureLlmValue } from '../../lib/llm.js';
import { getProvider } from '../../lib/prices.js';

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
  let secret;
  try {
    secret = getSessionSecret();
  } catch (error) {
    if (error instanceof ConfigError) return json({ error: 'Сервис не настроен' }, 503);
    throw error;
  }

  const session = verifyToken(extractToken(request), secret);
  if (!session) return json({ error: 'Нужно войти' }, 401);

  const settings = normalizeSettings((await getTradingSettings()) ?? {});

  if (request.method === 'POST') {
    if (session.role !== ROLES.OWNER) return json({ error: 'Недостаточно прав' }, 403);

    const body = await request.json().catch(() => null);
    if (!body) return json({ error: 'Некорректный запрос' }, 400);

    if (body.action === 'reset') {
      await savePositions([]);
      return json({ ok: true });
    }

    const updated = normalizeSettings({ ...settings, ...body.settings });
    if (!(await saveTradingSettings(updated))) {
      return json({ error: 'Не удалось сохранить настройки' }, 500);
    }
    return json({ settings: updated });
  }

  const positions = await getPositions();

  // Текущую цену берём для подсчёта плавающего результата открытых
  // позиций. Если поставщик недоступен — показываем журнал без него.
  let price = null;
  try {
    ({ price } = await getProvider().getQuote());
  } catch (error) {
    console.error('[trading] цена недоступна:', error.message);
  }

  const withFloating = positions.map((position) =>
    position.status === 'open' && price !== null
      ? { ...position, floating: floatingPnl(position, price) }
      : position,
  );

  return json({
    settings,
    canEdit: session.role === ROLES.OWNER,
    strategies: STRATEGIES,
    price,
    // Свежие сверху: в журнале интересна последняя активность.
    positions: withFloating.slice().reverse(),
    stats: summarize(positions, settings),
    llmValue: measureLlmValue(positions),
  });
};

export const config = { path: '/api/trading' };
