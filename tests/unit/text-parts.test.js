import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTextParts, textPartSnippet, textPartTone } from '../../src/text-parts.js';

test('long text is split into contiguous bounded review parts', () => {
  const text = `${'First sentence. '.repeat(35)}\n\n${'Second paragraph. '.repeat(30)}`;
  const disagreement = { begin: 120, end: 135, status: 'pending' };
  const parts = buildTextParts(text, [disagreement], 180);

  assert.ok(parts.length > 3);
  assert.equal(parts[0].begin, 0);
  assert.equal(parts.at(-1).end, Array.from(text).length);
  parts.slice(1).forEach((part, index) => assert.equal(part.begin, parts[index].end));
  assert.equal(parts.flatMap((part) => part.disagreements).length, 1);
});

test('text part tone summarizes clean, pending, and curated sections', () => {
  assert.equal(textPartTone({ disagreements: [] }), 'clean');
  assert.equal(textPartTone({ disagreements: [{ status: 'pending' }] }), 'pending');
  assert.equal(textPartTone({ disagreements: [{ status: 'resolved', decision: { type: 'custom_spans' } }] }), 'custom');
  assert.equal(textPartTone({ disagreements: [{ status: 'resolved', decision: { type: 'reject_all' } }] }), 'removed');
  assert.equal(textPartTone({ disagreements: [{ status: 'resolved', decision: { type: 'accept_candidate' } }] }), 'included');
  assert.equal(textPartTone({ disagreements: [], curatorSpans: [{ begin: 2, end: 4 }] }), 'custom');
});

test('part snippets are compact and whitespace-normalized', () => {
  assert.equal(textPartSnippet('One\n\n  two three', { begin: 0, end: 16 }, 12), 'One two thr…');
});
