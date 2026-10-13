import { describe, expect, it } from 'vitest';
import { ROLES, hasAtLeast, isKnownRole, issueToken, verifyToken } from '../lib/auth.js';

const SECRET = 'секрет-для-подписи-токенов';

describe('токены сессии', () => {
  it('разбирает собственный токен', () => {
    const token = issueToken({ login: 'tg1', role: ROLES.OWNER }, SECRET);
    expect(verifyToken(token, SECRET)).toMatchObject({ login: 'tg1', role: 'owner' });
  });

  it('отвергает токен, подписанный другим секретом', () => {
    const token = issueToken({ login: 'tg1', role: ROLES.OWNER }, SECRET);
    expect(verifyToken(token, 'другой-секрет')).toBeNull();
  });

  it('отвергает подмену роли в теле токена', () => {
    // Главная атака: поправить payload, чтобы стать владельцем.
    const token = issueToken({ login: 'tg2', role: ROLES.USER }, SECRET);
    const [payload, signature] = token.split('.');

    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    data.role = 'owner';
    const forged = Buffer.from(JSON.stringify(data)).toString('base64url');

    expect(verifyToken(`${forged}.${signature}`, SECRET)).toBeNull();
  });

  it('отвергает просроченный токен', () => {
    const old = issueToken({ login: 'tg1', role: ROLES.USER }, SECRET, 0);
    expect(verifyToken(old, SECRET, Date.now())).toBeNull();
  });

  it('отвергает мусор', () => {
    for (const bad of ['', 'abc', 'a.b.c', null, undefined, 123]) {
      expect(verifyToken(bad, SECRET)).toBeNull();
    }
  });

  it('отвергает неизвестную роль', () => {
    expect(verifyToken(issueToken({ login: 'x', role: 'superuser' }, SECRET), SECRET)).toBeNull();
  });
});

describe('роли', () => {
  it('знает все четыре', () => {
    for (const role of ['guest', 'user', 'admin', 'owner']) {
      expect(isKnownRole(role)).toBe(true);
    }
    expect(isKnownRole('superuser')).toBe(false);
  });

  it('выстроены по возрастанию прав', () => {
    expect(hasAtLeast(ROLES.OWNER, ROLES.ADMIN)).toBe(true);
    expect(hasAtLeast(ROLES.ADMIN, ROLES.USER)).toBe(true);
    expect(hasAtLeast(ROLES.USER, ROLES.GUEST)).toBe(true);
    expect(hasAtLeast(ROLES.GUEST, ROLES.USER)).toBe(false);
  });
});
