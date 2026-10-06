import { describe, expect, it } from 'vitest';
import {
  ROLES,
  hashPassword,
  issueToken,
  validateLogin,
  validatePassword,
  verifyPassword,
  verifyToken,
} from '../lib/auth.js';

const SECRET = 'секрет-для-подписи-токенов';

describe('хеширование паролей', () => {
  it('принимает верный пароль', () => {
    const hash = hashPassword('правильный-пароль');
    expect(verifyPassword('правильный-пароль', hash)).toBe(true);
  });

  it('отвергает неверный', () => {
    const hash = hashPassword('правильный-пароль');
    expect(verifyPassword('неправильный', hash)).toBe(false);
  });

  it('не хранит пароль в открытом виде', () => {
    expect(hashPassword('секрет123')).not.toContain('секрет123');
  });

  it('даёт разные хеши для одного пароля', () => {
    // Соль индивидуальная, иначе одинаковые пароли были бы видны
    // по совпадающим хешам.
    expect(hashPassword('одинаковый')).not.toBe(hashPassword('одинаковый'));
  });

  it('не падает на испорченном хеше', () => {
    expect(verifyPassword('пароль', 'мусор')).toBe(false);
    expect(verifyPassword('пароль', '')).toBe(false);
    expect(verifyPassword('пароль', null)).toBe(false);
    expect(verifyPassword('пароль', 'scrypt:только-соль')).toBe(false);
  });

  it('работает с паролем на кириллице и эмодзи', () => {
    const hash = hashPassword('пароль-с-эмодзи-🔐');
    expect(verifyPassword('пароль-с-эмодзи-🔐', hash)).toBe(true);
  });
});

describe('токены сессии', () => {
  it('разбирает собственный токен', () => {
    const token = issueToken({ login: 'vlad', role: ROLES.ADMIN }, SECRET);
    expect(verifyToken(token, SECRET)).toMatchObject({ login: 'vlad', role: 'admin' });
  });

  it('отвергает токен, подписанный другим секретом', () => {
    const token = issueToken({ login: 'vlad', role: ROLES.ADMIN }, SECRET);
    expect(verifyToken(token, 'другой-секрет')).toBeNull();
  });

  it('отвергает подмену роли в теле токена', () => {
    // Главная атака: пользователь правит payload, чтобы стать админом.
    const token = issueToken({ login: 'vasya', role: ROLES.USER }, SECRET);
    const [payload, signature] = token.split('.');

    const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
    data.role = 'admin';
    const forged = Buffer.from(JSON.stringify(data)).toString('base64url');

    expect(verifyToken(`${forged}.${signature}`, SECRET)).toBeNull();
  });

  it('отвергает просроченный токен', () => {
    const issuedLongAgo = issueToken({ login: 'vlad', role: ROLES.USER }, SECRET, 0);
    expect(verifyToken(issuedLongAgo, SECRET, Date.now())).toBeNull();
  });

  it('отвергает мусор вместо токена', () => {
    for (const bad of ['', 'abc', 'a.b.c', null, undefined, 123]) {
      expect(verifyToken(bad, SECRET)).toBeNull();
    }
  });

  it('отвергает неизвестную роль', () => {
    const token = issueToken({ login: 'x', role: 'superuser' }, SECRET);
    expect(verifyToken(token, SECRET)).toBeNull();
  });
});

describe('проверка логина', () => {
  it('принимает допустимый', () => {
    expect(validateLogin('vlad_99')).toEqual({ ok: true, value: 'vlad_99' });
  });

  it('приводит к нижнему регистру', () => {
    expect(validateLogin('VladKhan').value).toBe('vladkhan');
  });

  it('отвергает слишком короткий и слишком длинный', () => {
    expect(validateLogin('ab').ok).toBe(false);
    expect(validateLogin('a'.repeat(33)).ok).toBe(false);
  });

  it('отвергает кириллицу и пробелы', () => {
    expect(validateLogin('влад').ok).toBe(false);
    expect(validateLogin('vlad khan').ok).toBe(false);
  });
});

describe('проверка пароля', () => {
  it('требует не меньше восьми символов', () => {
    expect(validatePassword('1234567').ok).toBe(false);
    expect(validatePassword('12345678').ok).toBe(true);
  });

  it('отвергает слишком длинный', () => {
    expect(validatePassword('x'.repeat(201)).ok).toBe(false);
  });
});
