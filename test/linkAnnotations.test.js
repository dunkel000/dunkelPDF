const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TARGET_KINDS,
  classifyLinkAnnotation,
  parseDestinationTarget,
  deriveLabelForTarget
} = require('../media/linkAnnotations.js');

test('classifies LaTeX equation references', () => {
  const target = parseDestinationTarget('equation.7');
  assert.equal(target.kind, TARGET_KINDS.EQUATION);
  const label = deriveLabelForTarget(target);
  assert.equal(label, '(7)');

  const annotation = classifyLinkAnnotation({ subtype: 'Link', dest: 'equation.7' });
  assert.equal(annotation.kind, TARGET_KINDS.EQUATION);
  assert.equal(annotation.label, '(7)');
});

test('labels numeric citations as bracketed references', () => {
  const target = parseDestinationTarget('Hcite.12');
  assert.equal(target.kind, TARGET_KINDS.CITATION);
  assert.equal(target.identifier, '12');
  assert.equal(deriveLabelForTarget(target), '[12]');

  const annotation = classifyLinkAnnotation({ subtype: 'Link', dest: 'Hcite.12' });
  assert.equal(annotation.kind, TARGET_KINDS.CITATION);
  assert.equal(annotation.label, '[12]');
});

test('extracts citation labels for non-numeric identifiers', () => {
  const annotation = classifyLinkAnnotation({ subtype: 'Link', dest: 'cite.Smith2019' });
  assert.equal(annotation.kind, TARGET_KINDS.CITATION);
  assert.equal(annotation.label, '[Smith2019]');
});

test('uses parentheses for LaTeX footnote markers', () => {
  const annotation = classifyLinkAnnotation({ subtype: 'Link', dest: 'Hfootnote.3' });
  assert.equal(annotation.kind, TARGET_KINDS.FOOTNOTE);
  assert.equal(annotation.footnoteId, '3');
  assert.equal(annotation.label, '(3)');
});

test('derives section references from structured destinations', () => {
  const target = parseDestinationTarget('section.2.1');
  assert.equal(target.kind, TARGET_KINDS.SECTION);
  assert.equal(deriveLabelForTarget(target), 'Section 2.1');
});
