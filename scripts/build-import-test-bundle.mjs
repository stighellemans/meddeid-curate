import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectPath = path.join(rootDir, 'data', 'project.json');
const outputDir = path.resolve(process.argv[2] ?? path.join(rootDir, 'data', 'exports', 'import-test-bundle'));
const project = JSON.parse(await fs.readFile(projectPath, 'utf8'));

function compareSpans(left, right) {
  return left.begin - right.begin || left.end - right.end || left.label.localeCompare(right.label);
}

function sourceRows(source) {
  return project.documents.map((document) => {
    const spans = [
      ...document.consensus_spans.map(({ begin, end, text, label }) => ({ begin, end, text, label })),
      ...document.disagreements.flatMap((disagreement) => disagreement.candidates
        .filter((candidate) => candidate.present_in.includes(source.annotation_set_id))
        .map(({ span: { begin, end, text, label } }) => ({ begin, end, text, label }))),
    ].sort(compareSpans);
    return {
      document_id: document.document_id,
      text: document.text,
      spans,
      metadata: document.metadata ?? {},
      annotated: true,
    };
  });
}

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`;
}

await fs.mkdir(outputDir, { recursive: true });
const successfulFiles = [];
for (const [index, source] of project.sources.entries()) {
  const filename = `${String(index + 1).padStart(2, '0')}-${source.filename}`;
  await fs.writeFile(path.join(outputDir, filename), jsonl(sourceRows(source)), 'utf8');
  successfulFiles.push(filename);
}

const mismatchRowsA = sourceRows(project.sources[0]).slice(0, 2);
const mismatchRowsB = structuredClone(mismatchRowsA);
const mismatchDocument = mismatchRowsB[0];
const points = Array.from(mismatchDocument.text);
const protectedOffsets = new Set(mismatchDocument.spans.flatMap((span) => (
  Array.from({ length: span.end - span.begin }, (_unused, offset) => span.begin + offset)
)));
const mismatchOffset = points.findIndex((character, offset) => /\p{L}/u.test(character) && !protectedOffsets.has(offset));
if (mismatchOffset < 0) throw new Error('Could not find an unannotated character for the mismatch fixture');
const expectedCharacter = points[mismatchOffset];
const actualCharacter = expectedCharacter === 'X' ? 'Y' : 'X';
points[mismatchOffset] = actualCharacter;
mismatchDocument.text = points.join('');

const mismatchFileA = 'mismatch-01-reviewer-a.jsonl';
const mismatchFileB = 'mismatch-02-reviewer-b-text-changed.jsonl';
await fs.writeFile(path.join(outputDir, mismatchFileA), jsonl(mismatchRowsA), 'utf8');
await fs.writeFile(path.join(outputDir, mismatchFileB), jsonl(mismatchRowsB), 'utf8');
await fs.writeFile(path.join(outputDir, 'README.txt'), [
  'MedDeID Curate import test bundle',
  '',
  'Successful import:',
  ...successfulFiles.map((filename) => `- ${filename}`),
  '',
  'Intentional failure test:',
  `- Import ${mismatchFileA} and ${mismatchFileB} together.`,
  `- ${mismatchDocument.document_id} differs at Unicode code-point offset ${mismatchOffset}.`,
  `- The first file has ${JSON.stringify(expectedCharacter)}; the second has ${JSON.stringify(actualCharacter)}.`,
  '- The application should reject the import and report the filenames, offset, characters, lengths, and surrounding context.',
  '',
].join('\n'), 'utf8');

console.log(JSON.stringify({
  outputDir,
  successfulFiles,
  mismatchFiles: [mismatchFileA, mismatchFileB],
  mismatch: {
    documentId: mismatchDocument.document_id,
    offset: mismatchOffset,
    expectedCharacter,
    actualCharacter,
  },
}, null, 2));
