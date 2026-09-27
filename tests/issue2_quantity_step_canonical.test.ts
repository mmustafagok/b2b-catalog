import { describe, it, expect } from 'vitest';
import {
  isValidQuantityStep,
  isValidQuantity,
  nextValidQuantity,
  previousValidQuantity,
  normalizeQuantity,
  resolveEffectiveQuantityRules,
} from '../src/types/index.js';

describe('Wholesale Pack-Size Quantity Rules & Mathematics Test Suite', () => {
  describe('Wholesale Pack-Size Math (min=1, pack=2)', () => {
    const min = 1;
    const pack = 2;

    it('0 is valid (not in cart)', () => {
      expect(isValidQuantityStep(0, min, pack)).toBe(true);
      expect(isValidQuantity(0, min, pack)).toBe(true);
    });

    it('1 is invalid (not a multiple of pack size 2)', () => {
      expect(isValidQuantityStep(1, min, pack)).toBe(false);
      expect(isValidQuantity(1, min, pack)).toBe(false);
    });

    it('2 is valid (first pack multiple >= min)', () => {
      expect(isValidQuantityStep(2, min, pack)).toBe(true);
      expect(isValidQuantity(2, min, pack)).toBe(true);
    });

    it('3 is invalid (not a multiple of pack size 2)', () => {
      expect(isValidQuantityStep(3, min, pack)).toBe(false);
      expect(isValidQuantity(3, min, pack)).toBe(false);
    });

    it('4, 6, 8 are valid', () => {
      expect(isValidQuantityStep(4, min, pack)).toBe(true);
      expect(isValidQuantity(4, min, pack)).toBe(true);
      expect(isValidQuantityStep(6, min, pack)).toBe(true);
      expect(isValidQuantity(6, min, pack)).toBe(true);
      expect(isValidQuantityStep(8, min, pack)).toBe(true);
      expect(isValidQuantity(8, min, pack)).toBe(true);
    });

    it('stepping from 0 produces 2, then 4, then 6', () => {
      const q1 = nextValidQuantity(0, min, pack);
      expect(q1).toBe(2);
      const q2 = nextValidQuantity(q1, min, pack);
      expect(q2).toBe(4);
      const q3 = nextValidQuantity(q2, min, pack);
      expect(q3).toBe(6);
    });

    it('stepping down from 6 produces 4, then 2, then 0', () => {
      const q1 = previousValidQuantity(6, min, pack);
      expect(q1).toBe(4);
      const q2 = previousValidQuantity(q1, min, pack);
      expect(q2).toBe(2);
      const q3 = previousValidQuantity(q2, min, pack);
      expect(q3).toBe(0);
    });
  });

  describe('Wholesale Pack-Size Math (min=6, pack=3, max=20)', () => {
    const min = 6;
    const pack = 3;
    const max = 20;

    it('0 is valid (not in cart)', () => {
      expect(isValidQuantityStep(0, min, pack)).toBe(true);
    });

    it('3 is invalid (< min 6)', () => {
      expect(isValidQuantityStep(3, min, pack)).toBe(false);
      expect(isValidQuantity(3, min, pack)).toBe(false);
    });

    it('6 is valid (minimum order quantity and multiple of 3)', () => {
      expect(isValidQuantityStep(6, min, pack)).toBe(true);
      expect(isValidQuantity(6, min, pack)).toBe(true);
    });

    it('9, 12, 15, 18 are valid', () => {
      [9, 12, 15, 18].forEach((q) => {
        expect(isValidQuantityStep(q, min, pack)).toBe(true);
        expect(isValidQuantity(q, min, pack, max)).toBe(true);
      });
    });

    it('19 and 20 are invalid (not multiples of pack 3)', () => {
      expect(isValidQuantity(19, min, pack, max)).toBe(false);
      expect(isValidQuantity(20, min, pack, max)).toBe(false);
    });

    it('stepping sequence starting at 0: 6 -> 9 -> 12 -> 15 -> 18 and stops at 18 (never jumps to 20)', () => {
      let q = 0;
      q = nextValidQuantity(q, min, pack, max);
      expect(q).toBe(6);
      q = nextValidQuantity(q, min, pack, max);
      expect(q).toBe(9);
      q = nextValidQuantity(q, min, pack, max);
      expect(q).toBe(12);
      q = nextValidQuantity(q, min, pack, max);
      expect(q).toBe(15);
      q = nextValidQuantity(q, min, pack, max);
      expect(q).toBe(18);
      // Pressing + on 18 stays at 18 because max is 20 and 18 + 3 = 21 > 20
      q = nextValidQuantity(q, min, pack, max);
      expect(q).toBe(18);
    });

    it('stepping down from 18: 18 -> 15 -> 12 -> 9 -> 6 -> 0', () => {
      let q = 18;
      q = previousValidQuantity(q, min, pack);
      expect(q).toBe(15);
      q = previousValidQuantity(q, min, pack);
      expect(q).toBe(12);
      q = previousValidQuantity(q, min, pack);
      expect(q).toBe(9);
      q = previousValidQuantity(q, min, pack);
      expect(q).toBe(6);
      q = previousValidQuantity(q, min, pack);
      expect(q).toBe(0);
    });
  });

  describe('Wholesale Pack-Size Math (pack=3, max=20, min=1 default)', () => {
    it('sequences 3 -> 6 -> 9 -> 12 -> 15 -> 18 and caps at 18', () => {
      let q = 0;
      const sequence = [q];
      for (let i = 0; i < 7; i++) {
        q = nextValidQuantity(q, 1, 3, 20);
        sequence.push(q);
      }
      expect(sequence).toEqual([0, 3, 6, 9, 12, 15, 18, 18]);
    });
  });

  describe('Max quantity & pack=1 & bounds', () => {
    it('respects max quantity bound', () => {
      expect(isValidQuantity(10, 2, 2, 8)).toBe(false); // exceeds max 8
      expect(isValidQuantity(8, 2, 2, 8)).toBe(true);
      expect(nextValidQuantity(8, 2, 2, 8)).toBe(8); // capped at max
    });

    it('pack=1 allows all consecutive integers from min to max', () => {
      expect(isValidQuantity(1, 1, 1)).toBe(true);
      expect(isValidQuantity(2, 1, 1)).toBe(true);
      expect(isValidQuantity(3, 1, 1)).toBe(true);
    });

    it('normalizeQuantity clamps and aligns typed numbers to pack multiples', () => {
      expect(normalizeQuantity(3, 1, 2)).toBe(4); // 3 is not a multiple of 2 -> rounds to 4
      expect(normalizeQuantity(0, 1, 2)).toBe(0); // 0 unselects
      expect(normalizeQuantity(100, 6, 3, 20)).toBe(18); // 100 exceeds max 20 -> capped at highest valid multiple 18
      expect(normalizeQuantity(20, 6, 3, 20)).toBe(18); // 20 is not multiple of 3 -> capped at 18
    });
  });

  describe('Inherited catalog rules vs explicit variant overrides', () => {
    const catalog = { minQty: 2, maxQty: 100, qtyIncrement: 2 };

    it('inherits catalog rules when overrideQuantityRules is false/null', () => {
      const rules = resolveEffectiveQuantityRules(catalog, { overrideQuantityRules: false, minQty: 10, qtyIncrement: 5 });
      expect(rules.min).toBe(2);
      expect(rules.step).toBe(2);
      expect(rules.max).toBe(100);
    });

    it('uses explicit variant override when overrideQuantityRules is true', () => {
      const rules = resolveEffectiveQuantityRules(catalog, { overrideQuantityRules: true, minQty: 10, qtyIncrement: 5 });
      expect(rules.min).toBe(10);
      expect(rules.step).toBe(5);
    });

    it('ignores stale variant min/step values when overrideQuantityRules is false', () => {
      const rules = resolveEffectiveQuantityRules(catalog, { overrideQuantityRules: false, minQty: 999, qtyIncrement: 99 });
      expect(rules.min).toBe(2);
      expect(rules.step).toBe(2);
    });
  });

  describe('nextValidQuantity cannot clamp to invalid max & preserves isValidQuantity invariant', () => {
    it('invariant: isValidQuantity(nextValidQuantity(...)) is always true for non-zero result', () => {
      const testCases = [
        { min: 1, step: 2, max: 4 },
        { min: 6, step: 3, max: 20 },
        { min: 3, step: 3, max: 10 },
        { min: 4, step: 2, max: 12 },
        { min: 10, step: 10, max: 45 },
      ];

      for (const { min, step, max } of testCases) {
        let current = 0;
        for (let i = 0; i < 20; i++) {
          const next = nextValidQuantity(current, min, step, max);
          if (next > 0) {
            expect(isValidQuantity(next, min, step, max)).toBe(true);
          }
          if (next === current) break;
          current = next;
        }
      }
    });
  });
});
