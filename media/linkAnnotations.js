(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.dunkelPdfLinkAnnotations = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof self !== 'undefined' ? self : this, function () {
  const TARGET_KINDS = {
    FOOTNOTE: 'footnote',
    CITATION: 'citation',
    EQUATION: 'equation',
    SECTION: 'section',
    UNKNOWN: 'unknown'
  };

  function normalizeTargetString(value) {
    if (value === null || value === undefined) {
      return '';
    }
    if (typeof value === 'string') {
      return value;
    }
    if (typeof value === 'object' && 'name' in value && typeof value.name === 'string') {
      return value.name;
    }
    return String(value);
  }

  function sanitizeDestinationName(raw) {
    return normalizeTargetString(raw)
      .replace(/^[#\/]+/, '')
      .replace(/\s+/g, '')
      .trim();
  }

  function parseDestinationTarget(rawDestination) {
    const sanitized = sanitizeDestinationName(rawDestination);

    if (!sanitized) {
      return { kind: TARGET_KINDS.UNKNOWN, raw: sanitized };
    }

    const footnoteMatch = sanitized.match(/(?:^|\.)h?footnote\.(\d+)/i);
    if (footnoteMatch) {
      return {
        kind: TARGET_KINDS.FOOTNOTE,
        raw: sanitized,
        identifier: footnoteMatch[1]
      };
    }

    const citationMatch = sanitized.match(/(?:^|\.)h?cite\.([\w:-]+)/i);
    if (citationMatch) {
      return {
        kind: TARGET_KINDS.CITATION,
        raw: sanitized,
        identifier: citationMatch[1]
      };
    }

    const equationMatch = sanitized.match(/(?:^|\.)h?equation\.([\d.]+)/i);
    if (equationMatch) {
      return {
        kind: TARGET_KINDS.EQUATION,
        raw: sanitized,
        identifier: equationMatch[1]
      };
    }

    const sectionMatch = sanitized.match(/(?:^|\.)((?:sub)*section)\.([\d.]+)/i);
    if (sectionMatch) {
      return {
        kind: TARGET_KINDS.SECTION,
        raw: sanitized,
        identifier: sectionMatch[2],
        sectionType: sectionMatch[1].toLowerCase()
      };
    }

    return { kind: TARGET_KINDS.UNKNOWN, raw: sanitized };
  }

  function deriveLabelForTarget(target, fallbackText) {
    if (!target || target.kind === TARGET_KINDS.UNKNOWN) {
      return fallbackText || '';
    }

    const identifier = target.identifier ?? '';

    switch (target.kind) {
      case TARGET_KINDS.FOOTNOTE:
        return identifier ? `(${identifier})` : fallbackText || '';
      case TARGET_KINDS.CITATION: {
        const idText = identifier || fallbackText || '';
        return idText ? `[${idText}]` : '';
      }
      case TARGET_KINDS.EQUATION:
        return identifier ? `(${identifier})` : fallbackText || '';
      case TARGET_KINDS.SECTION: {
        const sectionLabel = identifier || fallbackText || '';
        if (!sectionLabel) {
          return '';
        }
        const sectionWord = target.sectionType === 'subsection' || target.sectionType === 'subsubsection'
          ? 'Section'
          : 'Section';
        return `${sectionWord} ${sectionLabel}`;
      }
      default:
        return fallbackText || '';
    }
  }

  function classifyLinkAnnotation(annotation) {
    if (!annotation || typeof annotation !== 'object') {
      return {
        kind: TARGET_KINDS.UNKNOWN,
        label: '',
        target: { kind: TARGET_KINDS.UNKNOWN, raw: '' }
      };
    }

    const possibleDestinations = [
      annotation.dest,
      annotation.destName,
      annotation.destination,
      annotation.name
    ];

    let parsedTarget = { kind: TARGET_KINDS.UNKNOWN, raw: '' };
    for (const candidate of possibleDestinations) {
      parsedTarget = parseDestinationTarget(candidate);
      if (parsedTarget.kind !== TARGET_KINDS.UNKNOWN) {
        break;
      }
    }

    const fallback = sanitizeDestinationName(annotation.url || annotation.title || annotation.contents || '');
    const label = deriveLabelForTarget(parsedTarget, fallback);

    return {
      kind: parsedTarget.kind,
      label,
      target: parsedTarget,
      rawDestination: parsedTarget.raw,
      footnoteId: parsedTarget.kind === TARGET_KINDS.FOOTNOTE ? parsedTarget.identifier : undefined
    };
  }

  return {
    TARGET_KINDS,
    parseDestinationTarget,
    deriveLabelForTarget,
    classifyLinkAnnotation
  };
});
