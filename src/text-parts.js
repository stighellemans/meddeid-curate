const BREAKS = ['\n\n', '\n', '. ', '? ', '! ', '; '];

function preferredBreak(chars, begin, idealEnd, minimumSize) {
  const minimumEnd = Math.min(idealEnd, begin + minimumSize);
  for (const marker of BREAKS) {
    const markerChars = Array.from(marker);
    for (let index = idealEnd - markerChars.length; index >= minimumEnd; index -= 1) {
      if (markerChars.every((character, offset) => chars[index + offset] === character)) {
        return index + markerChars.length;
      }
    }
  }
  return idealEnd;
}

export function buildTextParts(text, disagreements = [], maxCodepoints = 560, curatorSpans = []) {
  const chars = Array.from(text ?? '');
  if (chars.length === 0) return [{ begin: 0, end: 0, disagreements: [] }];

  const parts = [];
  let begin = 0;
  while (begin < chars.length) {
    const idealEnd = Math.min(chars.length, begin + maxCodepoints);
    const end = idealEnd === chars.length
      ? chars.length
      : preferredBreak(chars, begin, idealEnd, Math.floor(maxCodepoints * 0.45));
    parts.push({
      begin,
      end,
      disagreements: disagreements.filter((item) => item.begin < end && begin < item.end),
      curatorSpans: curatorSpans.filter((span) => span.begin < end && begin < span.end),
    });
    begin = end;
  }
  return parts;
}

export function textPartTone(part) {
  const items = part?.disagreements ?? [];
  if (items.some((item) => item.status !== 'resolved')) return 'pending';
  if ((part?.curatorSpans ?? []).length > 0) return 'custom';
  if (items.length === 0) return 'clean';
  if (items.some((item) => item.decision?.type === 'custom_spans')) return 'custom';
  if (items.every((item) => item.decision?.type === 'reject_all')) return 'removed';
  return 'included';
}

export function textPartSnippet(text, part, limit = 76) {
  const content = Array.from(text ?? '').slice(part.begin, part.end).join('').replace(/\s+/g, ' ').trim();
  return content.length > limit ? `${content.slice(0, limit - 1)}…` : content;
}
