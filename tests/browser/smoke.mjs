import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';

const rootDir = path.resolve(import.meta.dirname, '../..');

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

function start(args, env) {
  const child = spawn(process.execPath, args, {
    cwd: rootDir,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  child.stderr.on('data', (chunk) => { output += chunk; });
  child.output = () => output;
  return child;
}

async function waitFor(url, child) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Process exited:\n${child.output()}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${url}:\n${child.output()}`);
}

const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'meddeid-curate-browser-'));
const dataDir = path.join(tempDir, 'data');
const annotationA = path.join(tempDir, 'reviewer-a.jsonl');
const annotationB = path.join(tempDir, 'reviewer-b.jsonl');
const apiPort = await freePort();
const clientPort = await freePort();
const longContext = `\n\n${'This is synthetic clinical context for long-form curation. '.repeat(120)}`;
const rows = [
  { document_id: 'doc-001', text: `Alice arrived today.${longContext}`, annotated: true },
  { document_id: 'doc-002', text: `Bob arrived today.${longContext}`, annotated: true },
];
await fs.writeFile(annotationA, `${rows.map((row) => JSON.stringify({ ...row, spans: [
  { begin: 0, end: row.document_id === 'doc-001' ? 5 : 3, text: row.document_id === 'doc-001' ? 'Alice' : 'Bob', label: 'Name:Patient' },
  { begin: row.document_id === 'doc-001' ? 14 : 12, end: row.document_id === 'doc-001' ? 19 : 17, text: 'today', label: 'Date' },
] })).join('\n')}\n`);
await fs.writeFile(annotationB, `${rows.map((row) => JSON.stringify({ ...row, spans: row.document_id === 'doc-001' ? [
  { begin: 0, end: 5, text: 'Alice', label: 'Name:Other' },
  { begin: 14, end: 19, text: 'today', label: 'Date' },
] : [
  { begin: 12, end: 17, text: 'today', label: 'Date' },
] })).join('\n')}\n`);

const api = start(['server/index.js'], {
  HOST: '127.0.0.1',
  PORT: String(apiPort),
  MEDDEID_CURATE_DATA_DIR: dataDir,
});
const client = start(
  ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(clientPort)],
  { VITE_API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
);

let browser;
try {
  await Promise.all([
    waitFor(`http://127.0.0.1:${apiPort}/api/health`, api),
    waitFor(`http://127.0.0.1:${clientPort}`, client),
  ]);
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${clientPort}`);
  await page.getByRole('heading', { name: 'Build one defensible gold standard.' }).waitFor();
  await page.locator('input[type=file]').setInputFiles([annotationA, annotationB]);
  await page.getByRole('button', { name: 'Compare 2 annotation sets' }).click();
  await page.getByRole('heading', { name: 'doc-001' }).waitFor();
  await page.getByLabel('0 of 2 texts confirmed').waitFor();
  await page.getByLabel('Document difference map').waitFor();
  const partNumbers = await page.locator('.review-unit > kbd').allTextContents();
  if (partNumbers.length <= 9 || partNumbers.at(-1) !== String(partNumbers.length)) throw new Error('Text part numbering did not continue beyond 9');
  const visibleCuratedText = await page.getByLabel('Curated document text').innerText();
  if (visibleCuratedText.length >= rows[0].text.length) throw new Error('Long document was not divided into focused reading parts');
  const laneWindows = await page.locator('.lane-text').evaluateAll((nodes) => nodes.map((node) => `${node.dataset.windowBegin}-${node.dataset.windowEnd}`));
  if (new Set(laneWindows).size !== 1) throw new Error('Curated and source panes are not synchronized to one text part');
  await page.keyboard.press('2');
  await page.locator('.review-unit.active > kbd').getByText('2', { exact: true }).waitFor();
  if ((await page.getByLabel('Curated document text').getAttribute('data-window-begin')) === '0') throw new Error('Number shortcut did not navigate to the second text part');
  await page.keyboard.press('1');
  await page.locator('.review-unit.active > kbd').getByText('1', { exact: true }).waitFor();
  await page.keyboard.press('ArrowRight');
  await page.locator('.review-unit.active > kbd').getByText('2', { exact: true }).waitFor();
  await page.keyboard.press('ArrowLeft');
  await page.locator('.review-unit.active > kbd').getByText('1', { exact: true }).waitFor();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('heading', { name: 'doc-002' }).waitFor();
  await page.keyboard.press('ArrowUp');
  await page.getByRole('heading', { name: 'doc-001' }).waitFor();
  if (await page.getByRole('button', { name: '→' }).count()) throw new Error('Per-issue arrow navigation is still visible');
  if (await page.getByRole('button', { name: /Resolve with no span/i }).count()) throw new Error('Separate no-span control is still visible');
  if (await page.getByRole('button', { name: /Add another span|Save curated changes/i }).count()) throw new Error('Manual curator span controls are still visible');
  if (await page.getByRole('spinbutton').count()) throw new Error('Custom curation exposed raw offset fields');
  const documentRowHeights = await page.locator('.document-row').evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
  if (new Set(documentRowHeights).size !== 1) throw new Error('Document rows do not keep a stable height');
  if (await page.locator('.review-unit strong').count()) throw new Error('Text map still exposes substring previews');
  if (await page.locator('.review-unit').first().evaluate((node) => Math.round(node.getBoundingClientRect().width) !== Math.round(node.getBoundingClientRect().height))) throw new Error('Text map items are not square');
  const visibleSpanLabels = await page.locator('.lane-segment[data-label]').count();
  if (visibleSpanLabels === 0) throw new Error('Highlighted spans do not expose visible label badges');
  const patientLabelColor = await page.locator('.lane-segment[data-label="Name:Patient"]').first().evaluate((node) => getComputedStyle(node, '::before').backgroundColor);
  const otherLabelColor = await page.locator('.lane-segment[data-label="Name:Other"]').first().evaluate((node) => getComputedStyle(node, '::before').backgroundColor);
  if (patientLabelColor === otherLabelColor) throw new Error('Different annotation labels do not have distinct label colors');
  if (await page.locator('.document-toolbar kbd').count()) throw new Error('Toolbar shortcuts are still always visible');
  await page.getByLabel('Curated document text').getByRole('button', { name: 'today' }).click();
  await page.locator('.selected-span-compact').getByText('"today"', { exact: true }).waitFor();
  const consensusLabel = page.locator('.selected-span-compact .selected-span-label');
  if (await consensusLabel.textContent() !== 'Date') throw new Error('Selected agreed span does not show its label');
  if (await consensusLabel.evaluate((node) => getComputedStyle(node).backgroundColor === 'rgba(0, 0, 0, 0)')) throw new Error('Selected agreed span label does not show its label color');
  await page.getByLabel('Read-only annotations from reviewer-b.jsonl').getByRole('button', { name: 'Alice' }).click();
  await page.getByLabel('Curated document text').locator('button[data-label="Name:Other"]').waitFor();
  await page.getByLabel('Read-only annotations from reviewer-a.jsonl').getByRole('button', { name: 'Alice' }).click();
  await page.getByLabel('Curated document text').locator('button[data-label="Name:Patient"]').waitFor();
  const unselectedAlternativeStyle = await page.getByLabel('Read-only annotations from reviewer-b.jsonl').getByRole('button', { name: 'Alice' }).evaluate((node) => ({
    className: node.className,
    opacity: getComputedStyle(node).opacity,
    backgroundColor: getComputedStyle(node).backgroundColor,
  }));
  if (!unselectedAlternativeStyle.className.includes('rejected') || unselectedAlternativeStyle.opacity !== '1' || unselectedAlternativeStyle.backgroundColor !== 'rgb(247, 229, 210)') throw new Error('Unselected alternative does not use its distinct full-opacity color');
  await page.getByLabel('Curated document text').evaluate((node) => {
    const textNode = document.createTreeWalker(node, NodeFilter.SHOW_TEXT).nextNode();
    const range = document.createRange();
    range.setStart(textNode, 0);
    range.setEnd(textNode, 3);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator('.selected-span-compact').getByText('"Ali"', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'B Profession' }).click();
  await page.getByLabel('Curated document text').locator('button[data-label="Profession"]').waitFor();
  await page.reload();
  await page.getByLabel('Read-only annotations from reviewer-a.jsonl').getByRole('button', { name: 'Alice' }).click();
  await page.getByRole('heading', { name: 'doc-001' }).waitFor();
  await page.getByLabel('Curated document text').getByRole('button', { name: 'Alice' }).click();
  if (await page.getByText(/Curator span selected|Curated span selected/).count()) throw new Error('Redundant selected-span status box is still visible');
  const deleteButtonTitle = await page.getByRole('button', { name: 'Delete', exact: true }).getAttribute('title');
  if (!/^Delete selected span \((?:⌘|Ctrl\+)Delete\)$/.test(deleteButtonTitle)) throw new Error(`Delete shortcut is not platform-aware: ${deleteButtonTitle}`);
  if (await page.locator('.selected-span-compact').getByText(/Selected curated span|saved automatically/).count()) throw new Error('Selected span box still contains unnecessary metadata');
  if (await page.locator('.selected-span-compact .selected-span-label').textContent() !== 'Name:Patient') throw new Error('Selected span box does not show the span label');
  await page.keyboard.press('Control+Delete');
  await page.getByRole('heading', { name: 'No span retained' }).waitFor();
  await page.getByLabel('Read-only annotations from reviewer-a.jsonl').getByRole('button', { name: 'Alice' }).click();
  await page.getByRole('button', { name: /^Undo/ }).click();
  await page.getByRole('button', { name: /^Redo/ }).click();
  await page.getByRole('button', { name: 'Confirm text' }).click();
  await page.getByLabel('1 of 2 texts confirmed').waitFor();
  await page.getByRole('heading', { name: 'doc-002' }).waitFor();
  await page.getByLabel('Read-only annotations from reviewer-a.jsonl').getByRole('button', { name: 'Bob' }).click();
  await page.getByLabel('Curated document text').evaluate((node) => {
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const textNodes = [];
    let current;
    while ((current = walker.nextNode())) textNodes.push(current);
    const start = 4;
    const end = 11;
    let offset = 0;
    let startNode;
    let startOffset;
    let endNode;
    let endOffset;
    for (const textNode of textNodes) {
      const nextOffset = offset + textNode.data.length;
      if (!startNode && start >= offset && start <= nextOffset) {
        startNode = textNode;
        startOffset = start - offset;
      }
      if (!endNode && end >= offset && end <= nextOffset) {
        endNode = textNode;
        endOffset = end - offset;
        break;
      }
      offset = nextOffset;
    }
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.locator('.selected-span-compact').getByText('"arrived"', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'B Profession' }).click();
  await page.getByLabel('Curated document text').locator('button[data-label="Profession"]').waitFor();
  await page.reload();
  await page.getByLabel('Curated document text').getByRole('button', { name: 'arrived' }).click();
  await page.locator('.selected-span-compact').getByText('"arrived"', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm text' }).click();
  await page.getByLabel('2 of 2 texts confirmed').waitFor();
  await page.getByRole('button', { name: 'Publish gold' }).click();
  await page.getByRole('link', { name: 'Download gold' }).waitFor();
  const manifest = JSON.parse(await fs.readFile(path.join(dataDir, 'exports', 'manifest.json'), 'utf8'));
  if (manifest.hashes.decisions_sha256.length !== 64) throw new Error('Decision audit hash missing');
  console.log('MedDeID Curate browser smoke test passed.');
} finally {
  await browser?.close();
  api.kill('SIGTERM');
  client.kill('SIGTERM');
  await fs.rm(tempDir, { recursive: true, force: true });
}
