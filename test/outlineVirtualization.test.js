const assert = require('assert');
const { normalizeOutline, computeVirtualPageWindow } = require('../media/viewer-helpers.js');

describe('viewer helpers', () => {
  describe('normalizeOutline', () => {
    it('returns empty array when outline is missing', () => {
      assert.deepStrictEqual(normalizeOutline(null), []);
    });

    it('preserves hierarchy and metadata', () => {
      const input = [
        {
          title: 'Chapter 1',
          dest: 'dest-1',
          bold: true,
          color: [1, 0, 0],
          items: [
            {
              title: 'Section 1.1',
              dest: 'dest-1-1',
              italic: true
            }
          ]
        },
        {
          title: 'Appendix',
          dest: 'dest-appendix',
          items: []
        }
      ];

      const normalized = normalizeOutline(input, { idPrefix: 'node' });

      assert.strictEqual(normalized.length, 2);
      assert.match(normalized[0].id, /^node-\d+$/);
      assert.strictEqual(normalized[0].title, 'Chapter 1');
      assert.strictEqual(normalized[0].dest, 'dest-1');
      assert.strictEqual(normalized[0].bold, true);
      assert.deepStrictEqual(normalized[0].color, [1, 0, 0]);
      assert.strictEqual(normalized[0].children.length, 1);
      assert.strictEqual(normalized[0].children[0].depth, 1);
      assert.strictEqual(normalized[0].children[0].italic, true);
      assert.strictEqual(normalized[1].title, 'Appendix');
      assert.strictEqual(normalized[1].children.length, 0);
    });
  });

  describe('computeVirtualPageWindow', () => {
    it('handles totals of zero', () => {
      assert.deepStrictEqual(computeVirtualPageWindow({ totalPages: 0 }), { start: 0, end: 0 });
    });

    it('centers range around current page with buffer', () => {
      const window = computeVirtualPageWindow({
        totalPages: 100,
        currentPage: 50,
        visiblePages: 2,
        bufferPages: 3
      });

      assert.deepStrictEqual(window, { start: 47, end: 54 });
    });

    it('clamps near document bounds', () => {
      const startRange = computeVirtualPageWindow({
        totalPages: 10,
        currentPage: 1,
        visiblePages: 1,
        bufferPages: 2
      });

      assert.deepStrictEqual(startRange, { start: 1, end: 5 });

      const endRange = computeVirtualPageWindow({
        totalPages: 10,
        currentPage: 10,
        visiblePages: 2,
        bufferPages: 1
      });

      assert.deepStrictEqual(endRange, { start: 7, end: 10 });
    });
  });
});
