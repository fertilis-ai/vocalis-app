// Display mapping for clustered speaker labels (diarization). Labels from
// the engine are arbitrary, non-contiguous integers; the UI names them
// "Speaker A/B/…" and colors them in order of first appearance.

const PALETTE_SIZE = 5;

/** Distinct labels in order of first appearance. */
export function speakerOrder(segments: { speaker: number }[]): number[] {
  const order: number[] = [];
  for (const segment of segments) {
    if (!order.includes(segment.speaker)) order.push(segment.speaker);
  }
  return order;
}

/** Bare cluster letter "A", "B", … "AA" — mirrors Rust `letter_label`. */
export function speakerLetter(index: number): string {
  let name = "";
  let i = index;
  do {
    name = String.fromCharCode(65 + (i % 26)) + name;
    i = Math.floor(i / 26) - 1;
  } while (i >= 0);
  return name;
}

/** "Speaker A", "Speaker B", … "Speaker AA" past 26. */
export function speakerName(index: number): string {
  return `Speaker ${speakerLetter(index)}`;
}

/** Theme chart token for the nth speaker, cycling past the palette. */
export function speakerColor(index: number): string {
  return `var(--chart-${(index % PALETTE_SIZE) + 1})`;
}
