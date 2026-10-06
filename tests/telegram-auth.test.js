import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { displayName, validateInitData } from '../lib/telegram-auth.js';

const TOKEN = '123456:TEST-TOKEN';
const USER = { id: 1345915209, first_name: 'Влад', username: 'vlad' };

/** Подписывает поля так же, как это делает Telegram. */
function signInitData(fields, token = TOKEN) {
  const pairs = Object.entries(fields)
    .map(([k, v]) => `${k}=${v}`)
    .sort();
  const secret = createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = createHmac('sha256', secret).update(pairs.join('\n')).digest('hex');
  return new URLSearchParams({ ...fields, hash }).toString();
}

const baseFields = (overrides = {}) => ({
  auth_date: String(Math.floor(Date.now() / 1000)),
  query_id: 'AAEyfake',
  user: JSON.stringify(USER),
  ...overrides,
});

describe('подлинные данные', () => {
  it('принимаются', () => {
    const result = validateInitData(signInitData(baseFields()), TOKEN);
    expect(result.ok).toBe(true);
    expect(result.user.id).toBe(USER.id);
  });

  it('отдают профиль пользователя', () => {
    const result = validateInitData(signInitData(baseFields()), TOKEN);
    expect(result.user.username).toBe('vlad');
  });

  it('не зависят от порядка полей в строке', () => {
    // Telegram не гарантирует порядок; проверка сортирует поля сама.
    const signed = signInitData(baseFields());
    const params = [...new URLSearchParams(signed).entries()].reverse();
    const reordered = new URLSearchParams(params).toString();

    expect(validateInitData(reordered, TOKEN).ok).toBe(true);
  });

  it('не ломаются из-за поля signature', () => {
    // Новые версии Telegram добавляют signature; в расчёт хеша оно
    // не входит и должно отбрасываться.
    const signed = signInitData(baseFields()) + '&signature=' + 'c3Rvcm9ubnlheWE';
    expect(validateInitData(signed, TOKEN).ok).toBe(true);
  });
});

describe('подделки отвергаются', () => {
  it('подпись, сделанная чужим токеном', () => {
    const forged = signInitData(baseFields(), '999:ЧУЖОЙ-ТОКЕН');
    expect(validateInitData(forged, TOKEN)).toMatchObject({ ok: false });
  });

  it('подменённый идентификатор пользователя', () => {
    // Главная атака: выдать себя за владельца, подставив его ID.
    const signed = signInitData(baseFields());
    const tampered = signed.replace(String(USER.id), '999999');

    expect(validateInitData(tampered, TOKEN).reason).toContain('Подпись');
  });

  it('данные вообще без подписи', () => {
    const unsigned = new URLSearchParams(baseFields()).toString();
    expect(validateInitData(unsigned, TOKEN).reason).toContain('подписи');
  });

  it('пустая строка', () => {
    expect(validateInitData('', TOKEN).ok).toBe(false);
    expect(validateInitData(null, TOKEN).ok).toBe(false);
  });

  it('подпись правильной длины, но неверная', () => {
    const signed = signInitData(baseFields());
    const broken = signed.replace(/hash=([0-9a-f]+)/, (_, h) => 'hash=' + 'f'.repeat(h.length));

    expect(validateInitData(broken, TOKEN).ok).toBe(false);
  });
});

describe('срок годности', () => {
  it('устаревшие данные не принимаются', () => {
    // Иначе украденная строка работала бы вечно.
    const old = signInitData(baseFields({ auth_date: String(Math.floor(Date.now() / 1000) - 90000) }));
    expect(validateInitData(old, TOKEN).reason).toContain('устарели');
  });

  it('свежие принимаются', () => {
    const fresh = signInitData(baseFields({ auth_date: String(Math.floor(Date.now() / 1000) - 60) }));
    expect(validateInitData(fresh, TOKEN).ok).toBe(true);
  });

  it('срок можно задать', () => {
    const minuteAgo = signInitData(baseFields({ auth_date: String(Math.floor(Date.now() / 1000) - 60) }));
    expect(validateInitData(minuteAgo, TOKEN, { maxAgeMs: 30_000 }).ok).toBe(false);
  });

  it('данные без отметки времени не принимаются', () => {
    const fields = { query_id: 'AAE', user: JSON.stringify(USER) };
    expect(validateInitData(signInitData(fields), TOKEN).reason).toContain('времени');
  });
});

describe('профиль', () => {
  it('без пользователя данные не принимаются', () => {
    const fields = { auth_date: String(Math.floor(Date.now() / 1000)), query_id: 'AAE' };
    expect(validateInitData(signInitData(fields), TOKEN).reason).toContain('пользователя');
  });

  it('displayName предпочитает имя пользователя', () => {
    expect(displayName({ id: 1, username: 'vlad', first_name: 'Влад' })).toBe('@vlad');
  });

  it('displayName обходится без имени пользователя', () => {
    expect(displayName({ id: 1, first_name: 'Влад', last_name: 'Хан' })).toBe('Влад Хан');
  });

  it('displayName не остаётся пустым', () => {
    expect(displayName({ id: 42 })).toBe('id42');
  });
});
