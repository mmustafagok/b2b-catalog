import { describe, it, expect } from 'vitest';
import {
  isValidQuantityStep,
  isValidQuantity,
  nextValidQuantity,
  previousValidQuantity,
  normalizeQuantity,
  resolveEffectiveQuantityRules,
} from '../src/types/index.js';

describe('Issue 2: Canonical Quantity Rules & Mathematics Test Suite', () => {
  describe('Canonical Math (min=1, step=2)', () => {
    const min = 1;
    const step = 2;

    it('0 is valid (not in cart)', () => {
      expect(isValidQuantityStep(0, min, step)).toBe(true);
      expect(isValidQuantity(0, min, step)).toBe(true);
    });

    it('1 is valid (min quantity)', () => {
      expect(isValidQuantityStep(1, min, step)).toBe(true);
      expect(isValidQuantity(1, min, step)).toBe(true);
    });

    it('2 is invalid', () => {
      expect(isValidQuantityStep(2, min, step)).toBe(false);
      expect(isValidQuantity(2, min, step)).toBe(false);
    });

    it('3 is valid (min + step)', () => {
      expect(isValidQuantityStep(3, min, step)).toBe(true);
      expect(isValidQuantity(3, min, step)).toBe(true);
    });

    it('5 is valid', () => {
      expect(isValidQuantityStep(5, min, step)).toBe(true);
      expect(isValidQuantity(5, min, step)).toBe(true);
    });

    it('stepping from 0 produces 1, then 3, then 5', () => {
      const q1 = nextValidQuantity(0, min, step);
      expect(q1).toBe(1);
      const q2 = nextValidQuantity(q1, min, step);
      expect(q2).toBe(3);
      const q3 = nextValidQuantity(q2, min, step);
      expect(q3).toBe(5);
    });

    it('stepping down from 5 produces 3, then 1, then 0', () => {
      const q1 = previousValidQuantity(5, min, step);
      expect(q1).toBe(3);
      const q2 = previousValidQuantity(q1, min, step);
      expect(q2).toBe(1);
      const q3 = previousValidQuantity(q2, min, step);
      expect(q3).toBe(0);
    });
  });

  describe('Canonical Math (min=6, step=4)', () => {
    const min = 6;
    const step = 4;

    it('0 is valid (not in cart)', () => {
      expect(isValidQuantityStep(0, min, step)).toBe(true);
    });

    it('4 is invalid (< min 6)', () => {
      expect(isValidQuantityStep(4, min, step)).toBe(false);
    });

    it('6 is valid (min quantity)', () => {
      expect(isValidQuantityStep(6, min, step)).toBe(true);
      expect(isValidQuantity(6, min, step)).toBe(true);
    });

    it('10 is valid (min + step)', () => {
      expect(isValidQuantityStep(10, min, step)).toBe(true);
      expect(isValidQuantity(10, min, step)).toBe(true);
    });

    it('14 is valid', () => {
      expect(isValidQuantityStep(14, min, step)).toBe(true);
      expect(isValidQuantity(14, min, step)).toBe(true);
    });

    it('stepping sequence starting at 0: 6 -> 10 -> 14 -> 18', () => {
      let q = 0;
      q = nextValidQuantity(q, min, step);
      expect(q).toBe(6);
      q = nextValidQuantity(q, min, step);
      expect(q).toBe(10);
      q = nextValidQuantity(q, min, step);
      expect(q).toBe(14);
      q = nextValidQuantity(q, min, step);
      expect(q).toBe(18);
    });
  });

  describe('Max quantity & step=1 & bounds', () => {
    it('respects max quantity bound', () => {
      expect(isValidQuantity(10, 2, 2, 8)).toBe(false); // exceeds max 8
      expect(isValidQuantity(8, 2, 2, 8)).toBe(true);
      expect(nextValidQuantity(8, 2, 2, 8)).toBe(8); // capped at max
    });

    it('step=1 allows all consecutive integers from min to max', () => {
      expect(isValidQuantity(1, 1, 1)).toBe(true);
      expect(isValidQuantity(2, 1, 1)).toBe(true);
      expect(isValidQuantity(3, 1, 1)).toBe(true);
    });

    it('normalizeQuantity clamps and aligns typed numbers', () => {
      expect(normalizeQuantity(3, 1, 2)).toBe(3); // 3 is valid under min=1, step=2
      expect(normalizeQuantity(0, 1, 2)).toBe(0); // 0 unselects
      expect(normalizeQuantity(100, 1, 2, 10)).toBe(9); // 100 exceeds max -> capped at max valid step 9
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

  describe('Issue 5: nextValidQuantity cannot clamp to invalid max & preserves isValidQuantity invariant', () => {
    it('step=3 max=20 (from PART 4 spec): sequences 0 -> 1 -> 4 -> 7 -> 10 -> 13 -> 16 -> 19 and stops at 19', () => {
      expect(isValidQuantity(0, 1, 3, 20)).toBe(true);
      expect(isValidQuantity(1, 1, 3, 20)).toBe(true);
      expect(isValidQuantity(19, 1, 3, 20)).toBe(true);
      expect(isValidQuantity(20, 1, 3, 20)).toBe(false);

      let q = 0;
      const sequence = [q];
      for (let i = 0; i < 7; i++) {
        q = nextValidQuantity(q, 1, 3, 20);
        sequence.push(q);
      }
      expect(sequence).toEqual([0, 1, 4, 7, 10, 13, 16, 19]);
    });

    it('min=6 step=3: sequences 0 -> 6 -> 9 -> 12', () => {
      expect(isValidQuantity(0, 6, 3)).toBe(true);
      expect(isValidQuantity(3, 6, 3)).toBe(false); // < min 6
      expect(isValidQuantity(6, 6, 3)).toBe(true);
      expect(isValidQuantity(9, 6, 3)).toBe(true);

      const q1 = nextValidQuantity(0, 6, 3);
      expect(q1).toBe(6);
      const q2 = nextValidQuantity(q1, 6, 3);
      expect(q2).toBe(9);
    });

    it('min=6 step=4 max=15: valid 6, 10, 14; 14 + must NOT become 15', () => {
      expect(isValidQuantity(6, 6, 4, 15)).toBe(true);
      expect(isValidQuantity(10, 6, 4, 15)).toBe(true);
      expect(isValidQuantity(14, 6, 4, 15)).toBe(true);
      expect(isValidQuantity(15, 6, 4, 15)).toBe(false);

      expect(nextValidQuantity(0, 6, 4, 15)).toBe(6);
      expect(nextValidQuantity(6, 6, 4, 15)).toBe(10);
      expect(nextValidQuantity(10, 6, 4, 15)).toBe(14);
      // Pressing + on 14 must NOT become 15
      expect(nextValidQuantity(14, 6, 4, 15)).toBe(14);
    });

    it('min=5 step=5 max=20: sequences 5 -> 10 -> 15 -> 20', () => {
      let q = 0;
      q = nextValidQuantity(q, 5, 5, 20);
      expect(q).toBe(5);
      q = nextValidQuantity(q, 5, 5, 20);
      expect(q).toBe(10);
      q = nextValidQuantity(q, 5, 5, 20);
      expect(q).toBe(15);
      q = nextValidQuantity(q, 5, 5, 20);
      expect(q).toBe(20);
      q = nextValidQuantity(q, 5, 5, 20);
      expect(q).toBe(20);
    });

    it('invariant: isValidQuantity(nextValidQuantity(...)) is always true for non-zero result', () => {
      const testCases = [
        { min: 1, step: 2, max: 4 },
        { min: 6, step: 4, max: 15 },
        { min: 3, step: 3, max: 10 },
        { min: 5, step: 2, max: 12 },
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
