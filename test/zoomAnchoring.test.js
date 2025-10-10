const assert = require('assert');
const {
  computeScrollAnchorFromRects,
  computeScrollTopForAnchor
} = require('../media/viewer-helpers.js');

describe('scroll anchor helpers', () => {
  it('derives offset for a slot currently in view', () => {
    const metrics = computeScrollAnchorFromRects({
      containerTop: 100,
      containerScrollTop: 500,
      slotTop: 80,
      slotHeight: 720
    });

    assert.ok(metrics);
    assert.strictEqual(metrics.slotScrollTop, 480);
    assert.strictEqual(metrics.offset, 20);
  });

  it('clamps offsets before or beyond the slot bounds', () => {
    const beforeMetrics = computeScrollAnchorFromRects({
      containerTop: 50,
      containerScrollTop: 0,
      slotTop: 200,
      slotHeight: 600
    });

    assert.ok(beforeMetrics);
    assert.strictEqual(beforeMetrics.offset, 0);

    const afterMetrics = computeScrollAnchorFromRects({
      containerTop: 20,
      containerScrollTop: 2000,
      slotTop: -900,
      slotHeight: 800
    });

    assert.ok(afterMetrics);
    assert.strictEqual(afterMetrics.offset, 800);
  });

  it('computes scroll targets for preserved anchors', () => {
    const slotScrollTop = 720;
    const target = computeScrollTopForAnchor({
      slotScrollTop,
      offset: 400,
      slotHeight: 600
    });

    assert.strictEqual(target, 1120);

    const clampedTarget = computeScrollTopForAnchor({
      slotScrollTop,
      offset: 900,
      slotHeight: 600
    });

    assert.strictEqual(clampedTarget, 1320);
  });
});
