// Splits streamed LLM text deltas into sentences as they arrive, for
// per-sentence TTS in voice mode (spec M4 item 3). Deliberately dumb
// heuristics, matching `stripMarkdownForSpeech`'s convention: fenced code
// blocks are dropped entirely (reading code aloud is noise — incrementally,
// since the whole-message regex approach there can't run on a partial
// stream), and a "." doesn't end a sentence when it's a decimal point or
// trails a common abbreviation. Inline markdown (bold, links, backticks) is
// intentionally left alone here — the caller runs `stripMarkdownForSpeech`
// on each emitted sentence before synthesis, so that regex isn't duplicated.

const ABBREVIATIONS = new Set([
  "mr",
  "mrs",
  "ms",
  "dr",
  "prof",
  "sr",
  "jr",
  "st",
  "vs",
  "etc",
  "approx",
  "no",
  "vol",
  "fig",
  "inc",
  "ltd",
  "co",
  "corp",
  "jan",
  "feb",
  "mar",
  "apr",
  "jun",
  "jul",
  "aug",
  "sep",
  "sept",
  "oct",
  "nov",
  "dec",
]);

// "e.g."/"i.e." have an internal period that the whitespace check below
// already skips (no space between "e" and "g"); this only needs to catch
// the trailing period, which single-word abbreviations don't cover.
const DOTTED_ABBREVIATION_RE = /\b(?:e\.g|i\.e)\.$/i;

function isAbbreviation(textUpToPeriod: string): boolean {
  if (DOTTED_ABBREVIATION_RE.test(textUpToPeriod)) return true;
  const match = /([A-Za-z]+)\.$/.exec(textUpToPeriod);
  return !!match && ABBREVIATIONS.has(match[1].toLowerCase());
}

/** Index just past the first complete sentence in `text` starting the scan at
 * `from`, or `end: -1` if the buffer doesn't yet contain one (more text may
 * still extend a trailing number/abbreviation/word). `resume` is where the
 * next scan of the same buffer can safely pick up once more text arrives:
 * every terminator before it was rejected for a reason more text can't undo
 * (decimal point, known abbreviation, non-space follower), so re-checking it
 * per delta would make streaming a long sentence quadratic. */
function findSentenceEnd(text: string, from: number): { end: number; resume: number } {
  const terminators = /[.!?]+/g;
  terminators.lastIndex = from;
  let match: RegExpExecArray | null = terminators.exec(text);
  while (match !== null) {
    const start = match.index;
    const end = start + match[0].length;
    const isSingleDot = match[0] === ".";
    if (isSingleDot && /\d/.test(text[start - 1] ?? "") && /\d/.test(text[end] ?? "")) {
      match = terminators.exec(text);
      continue; // decimal point, e.g. "3.14"
    }
    if (isSingleDot && isAbbreviation(text.slice(0, end))) {
      match = terminators.exec(text);
      continue;
    }
    let after = end;
    if (after < text.length && '"\')'.includes(text[after])) after++;
    if (after >= text.length) return { end: -1, resume: start }; // could still extend with more text
    if (/\s/.test(text[after])) return { end: after, resume: 0 };
    match = terminators.exec(text);
  }
  return { end: -1, resume: text.length };
}

export interface SentenceChunker {
  /** Feed a new text delta; returns zero or more complete sentences ready to speak. */
  push(delta: string): string[];
  /** Call once the stream ends; returns any trailing buffered text as a final sentence. */
  flush(): string[];
}

// Trailing 1-2 backticks might be the start of a "```" fence split across
// two deltas — withhold them rather than committing to prose or discarding
// as code, so the next push can complete the match.
const PARTIAL_FENCE_RE = /`{1,2}$/;

export function createSentenceChunker(): SentenceChunker {
  let buffer = "";
  let inCodeBlock = false;
  let pendingTail = "";
  // Where the next findSentenceEnd scan of `buffer` resumes — persists across
  // pushes (appends keep the prefix intact) and resets whenever a sentence is
  // sliced off the front.
  let scanFrom = 0;

  function drainSentences(): string[] {
    const sentences: string[] = [];
    for (;;) {
      const { end, resume } = findSentenceEnd(buffer, scanFrom);
      if (end === -1) {
        scanFrom = resume;
        return sentences;
      }
      const sentence = buffer.slice(0, end).trim();
      if (sentence) sentences.push(sentence);
      buffer = buffer.slice(end);
      scanFrom = 0;
    }
  }

  function ingest(delta: string): string[] {
    let rest = pendingTail + delta;
    pendingTail = "";
    const sentences: string[] = [];
    for (;;) {
      if (inCodeBlock) {
        const closeIdx = rest.indexOf("```");
        if (closeIdx === -1) {
          pendingTail = PARTIAL_FENCE_RE.exec(rest)?.[0] ?? "";
          return sentences;
        }
        rest = rest.slice(closeIdx + 3);
        inCodeBlock = false;
        continue;
      }
      const openIdx = rest.indexOf("```");
      if (openIdx === -1) {
        const partial = PARTIAL_FENCE_RE.exec(rest)?.[0] ?? "";
        buffer += rest.slice(0, rest.length - partial.length);
        pendingTail = partial;
        sentences.push(...drainSentences());
        return sentences;
      }
      buffer += rest.slice(0, openIdx);
      sentences.push(...drainSentences());
      rest = rest.slice(openIdx + 3);
      inCodeBlock = true;
    }
  }

  return {
    push(delta: string): string[] {
      return ingest(delta);
    },
    flush(): string[] {
      inCodeBlock = false;
      pendingTail = "";
      const sentences = drainSentences();
      const rest = buffer.trim();
      buffer = "";
      scanFrom = 0;
      if (rest) sentences.push(rest);
      return sentences;
    },
  };
}
