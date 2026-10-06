import { describe, expect, it } from 'vitest';
import { getActiveSessions, isMarketOpen } from '../lib/sessions.js';

/** Удобный конструктор даты в UTC: utc(день_недели_через_дату, час). */
const utc = (iso) => new Date(iso);

describe('getActiveSessions', () => {
  it('ночью по UTC идёт только азиатская сессия', () => {
    // среда, 02:00 UTC
    expect(getActiveSessions(utc('2026-10-07T02:00:00Z'))).toEqual(['asia']);
  });

  it('утром Азия и Лондон пересекаются', () => {
    expect(getActiveSessions(utc('2026-10-07T08:30:00Z'))).toEqual(['asia', 'london']);
  });

  it('днём идёт пересечение Лондона и Нью-Йорка', () => {
    expect(getActiveSessions(utc('2026-10-07T14:00:00Z'))).toEqual(['london', 'newyork']);
  });

  it('вечером остаётся только Нью-Йорк', () => {
    expect(getActiveSessions(utc('2026-10-07T18:00:00Z'))).toEqual(['newyork']);
  });

  it('поздней ночью не идёт ни одна сессия', () => {
    expect(getActiveSessions(utc('2026-10-07T22:30:00Z'))).toEqual([]);
  });

  it('границы интервала не включают правый край', () => {
    // 09:00 — Азия уже закончилась, Лондон ещё идёт
    expect(getActiveSessions(utc('2026-10-07T09:00:00Z'))).toEqual(['london']);
  });
});

describe('isMarketOpen', () => {
  it('в будний день рынок открыт', () => {
    expect(isMarketOpen(utc('2026-10-07T12:00:00Z'))).toBe(true); // среда
  });

  it('в субботу рынок закрыт весь день', () => {
    expect(isMarketOpen(utc('2026-10-10T12:00:00Z'))).toBe(false);
  });

  it('в пятницу после 21:00 UTC рынок закрывается', () => {
    expect(isMarketOpen(utc('2026-10-09T20:00:00Z'))).toBe(true);
    expect(isMarketOpen(utc('2026-10-09T21:00:00Z'))).toBe(false);
  });

  it('в воскресенье рынок открывается в 22:00 UTC', () => {
    expect(isMarketOpen(utc('2026-10-11T21:00:00Z'))).toBe(false);
    expect(isMarketOpen(utc('2026-10-11T22:00:00Z'))).toBe(true);
  });
});
