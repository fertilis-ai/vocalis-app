// Word-level diff for the punctuation tool's before/after view. Classic LCS
// on whitespace tokens — punctuation restoration only inserts marks and
// changes casing, so inputs stay small and near-identical.

export interface DiffSpan {
  type: "same" | "added" | "removed";
  text: string;
}

function tokenize(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/** Merge consecutive spans of the same type into one (space-joined). */
function push(spans: DiffSpan[], type: DiffSpan["type"], token: string) {
  const last = spans[spans.length - 1];
  if (last && last.type === type) {
    last.text += ` ${token}`;
  } else {
    spans.push({ type, text: token });
  }
}

export function diffWords(before: string, after: string): DiffSpan[] {
  const a = tokenize(before);
  const b = tokenize(after);

  // lcs[i][j] = LCS length of a[i..] and b[j..]
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () =>
    new Array(b.length + 1).fill(0),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i][j] =
        a[i] === b[j]
          ? lcs[i + 1][j + 1] + 1
          : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }

  const spans: DiffSpan[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push(spans, "same", a[i]);
      i++;
      j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      push(spans, "removed", a[i]);
      i++;
    } else {
      push(spans, "added", b[j]);
      j++;
    }
  }
  while (i < a.length) push(spans, "removed", a[i++]);
  while (j < b.length) push(spans, "added", b[j++]);
  return spans;
}
