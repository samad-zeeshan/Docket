import { describe, it, expect } from 'vitest';
import { mapSroie, mapCord, parseSroieDate, parseAmount, splitOf } from '../eval/public/map';

describe('parseSroieDate', () => {
  it('reads the day first, the way Malaysian receipts print it', () => {
    expect(parseSroieDate('15/01/2019')).toBe('2019-01-15');
    expect(parseSroieDate('02-01-2019')).toBe('2019-01-02');
  });

  it('widens a two digit year', () => {
    expect(parseSroieDate('25/12/18')).toBe('2018-12-25');
  });

  it('reads a month name', () => {
    expect(parseSroieDate('06 JAN 2018')).toBe('2018-01-06');
    expect(parseSroieDate('06-Jan-2018')).toBe('2018-01-06');
  });

  it('accepts an ISO date as it is', () => {
    expect(parseSroieDate('2018-03-09')).toBe('2018-03-09');
  });

  it('refuses a date that is not on the calendar instead of guessing', () => {
    expect(parseSroieDate('31/02/2018')).toBeUndefined();
    expect(parseSroieDate('not a date')).toBeUndefined();
  });
});

describe('parseAmount', () => {
  it('treats a trailing three digit group as thousands, as CORD prints rupiah', () => {
    expect(parseAmount('16,500')).toBe(16500);
    expect(parseAmount('23.000')).toBe(23000);
    expect(parseAmount('1.234.000')).toBe(1234000);
  });

  it('keeps two decimals as cents', () => {
    expect(parseAmount('193.00')).toBe(193);
    expect(parseAmount('RM 9.90')).toBe(9.9);
    expect(parseAmount('1,591.50')).toBe(1591.5);
  });

  it('returns undefined for text with no number in it', () => {
    expect(parseAmount('')).toBeUndefined();
    expect(parseAmount('free')).toBeUndefined();
  });
});

describe('mapSroie', () => {
  it('maps company, date and total, and says which fields it labelled', () => {
    const m = mapSroie({ company: 'OJC MARKETING SDN BHD', date: '15/01/2019', address: 'x', total: '193.00' });
    expect(m.label).toEqual({ merchant: 'OJC MARKETING SDN BHD', date: '2019-01-15', total: 193 });
    expect(m.fields).toEqual(['merchant', 'date', 'total']);
  });

  it('drops a field it cannot parse rather than scoring against a guess', () => {
    const m = mapSroie({ company: 'SHOP', date: '??', address: '', total: '5.00' });
    expect(m.fields).toEqual(['merchant', 'total']);
    expect(m.label.date).toBeUndefined();
  });
});

describe('mapCord', () => {
  it('maps menu lines, subtotal, tax and total', () => {
    const m = mapCord({
      menu: [
        { nm: 'REAL GANACHE', cnt: '1', price: '16,500' },
        { nm: 'EGG TART', cnt: '2', price: '26,000' },
      ],
      sub_total: { subtotal_price: '42,500', tax_price: '4,250' },
      total: { total_price: '46,750', cashprice: '50,000' },
    });
    expect(m.label.lineItems).toEqual([
      { description: 'REAL GANACHE', quantity: 1, amount: 16500 },
      { description: 'EGG TART', quantity: 2, amount: 26000 },
    ]);
    expect(m.label.subtotal).toBe(42500);
    expect(m.label.tax).toBe(4250);
    expect(m.label.total).toBe(46750);
    expect(m.fields).toEqual(['lineItems', 'subtotal', 'tax', 'total']);
  });

  it('accepts a single menu line given as an object', () => {
    const m = mapCord({ menu: { nm: 'Kopi Susu Kolonel', cnt: '1', price: '23.000' }, total: { total_price: '23.000' } });
    expect(m.label.lineItems).toEqual([{ description: 'Kopi Susu Kolonel', quantity: 1, amount: 23000 }]);
  });

  it('labels subtotal and tax as absent when the receipt has neither', () => {
    const m = mapCord({ menu: [{ nm: 'A', cnt: '1', price: '1,000' }], total: { total_price: '1,000' } });
    expect(m.fields).toContain('subtotal');
    expect(m.label.subtotal).toBeUndefined();
  });

  it('leaves line items unlabelled when a line has no price', () => {
    const m = mapCord({ menu: [{ nm: 'A', cnt: '1', price: '1,000' }, { nm: 'topping' }], total: { total_price: '1,000' } });
    expect(m.fields).not.toContain('lineItems');
  });

  it('leaves the total unlabelled when the annotators recorded two', () => {
    const m = mapCord({ menu: [{ nm: 'A', cnt: '1', price: '1,000' }], total: { total_price: ['1,000', '900'] } });
    expect(m.fields).not.toContain('total');
  });
});

describe('splitOf', () => {
  it('is stable and puts about half the receipts in fit', () => {
    expect(splitOf('X00016469670')).toBe(splitOf('X00016469670'));
    const counts = { fit: 0, val: 0, test: 0 };
    for (let i = 0; i < 2000; i++) counts[splitOf(`id-${i}`)] += 1;
    expect(counts.fit).toBeGreaterThan(900);
    expect(counts.fit).toBeLessThan(1100);
    expect(counts.test).toBeGreaterThan(400);
  });
});
