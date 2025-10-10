(function (global, factory) {
  if (typeof module === 'object' && typeof module.exports === 'object') {
    module.exports = factory();
  } else {
    const namespace = factory();
    global.ViewerShared = Object.assign({}, global.ViewerShared, namespace);
  }
})(typeof self !== 'undefined' ? self : this, function () {
  function normalizeOutline(items, options = {}) {
    const outline = Array.isArray(items) ? items : [];
    const result = [];
    const idPrefix = typeof options.idPrefix === 'string' ? options.idPrefix : 'outline';
    let counter = 0;

    const visit = (nodes, depth, accumulator) => {
      nodes.forEach(node => {
        if (!node || typeof node !== 'object') {
          return;
        }

        const title = typeof node.title === 'string' ? node.title.trim() : '';
        const dest = node.dest ?? null;
        const url = node.url ?? null;
        const bold = Boolean(node.bold);
        const italic = Boolean(node.italic);
        const color = Array.isArray(node.color) ? node.color.slice() : null;
        const children = Array.isArray(node.items) ? node.items : [];

        const entry = {
          id: `${idPrefix}-${counter++}`,
          title,
          dest,
          url,
          bold,
          italic,
          color,
          depth,
          children: []
        };

        accumulator.push(entry);
        visit(children, depth + 1, entry.children);
      });
    };

    visit(outline, 0, result);
    return result;
  }

  function computeVirtualPageWindow(options) {
    const totalPages = clampToPositiveInteger(options?.totalPages) ?? 0;
    if (!totalPages) {
      return { start: 0, end: 0 };
    }

    const currentPage = clampPage(options?.currentPage, totalPages) ?? 1;
    const visiblePages = Math.max(1, Math.trunc(options?.visiblePages ?? 1));
    const bufferPages = Math.max(0, Math.trunc(options?.bufferPages ?? 2));

    const desiredRange = visiblePages + bufferPages * 2;
    let start = currentPage - Math.ceil((visiblePages + bufferPages) / 2);
    start = clampPage(start, totalPages) ?? 1;
    let end = start + desiredRange - 1;

    if (end > totalPages) {
      end = totalPages;
      start = Math.max(1, end - desiredRange + 1);
    }

    if (end - start + 1 < visiblePages) {
      end = Math.min(totalPages, start + visiblePages - 1);
    }

    return { start, end };
  }

  function clampAnchorOffset(offset, slotHeight) {
    if (!Number.isFinite(offset)) {
      return 0;
    }

    if (!Number.isFinite(slotHeight) || slotHeight <= 0) {
      return Math.max(0, offset);
    }

    const maxOffset = Math.max(0, slotHeight);
    return Math.max(0, Math.min(offset, maxOffset));
  }

  function computeScrollAnchorFromRects(options = {}) {
    const containerTop = options?.containerTop;
    const containerScrollTop = options?.containerScrollTop;
    const slotTop = options?.slotTop;
    const slotHeight = options?.slotHeight;

    if (
      !Number.isFinite(containerTop) ||
      !Number.isFinite(containerScrollTop) ||
      !Number.isFinite(slotTop)
    ) {
      return null;
    }

    const slotScrollTop = containerScrollTop + slotTop - containerTop;
    const rawOffset = containerScrollTop - slotScrollTop;
    const offset = clampAnchorOffset(rawOffset, slotHeight);

    return { slotScrollTop, offset };
  }

  function computeScrollTopForAnchor(options = {}) {
    const slotScrollTop = options?.slotScrollTop;
    const offset = options?.offset;
    const slotHeight = options?.slotHeight;

    if (!Number.isFinite(slotScrollTop)) {
      return null;
    }

    const clampedOffset = clampAnchorOffset(offset, slotHeight);
    return slotScrollTop + clampedOffset;
  }

  function clampToPositiveInteger(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return null;
    }
    const normalized = Math.trunc(value);
    return normalized > 0 ? normalized : null;
  }

  function clampPage(value, totalPages) {
    const normalized = clampToPositiveInteger(value);
    if (normalized === null) {
      return null;
    }
    return Math.min(Math.max(1, normalized), totalPages);
  }

  return {
    normalizeOutline,
    computeVirtualPageWindow,
    computeScrollAnchorFromRects,
    computeScrollTopForAnchor
  };
});
