// Read-aloud text prep (spec M4 item 2). Ported from Sapio's speech.ts.

export const MAX_SPEECH_INPUT_CHARS = 4096;

/**
 * Reduce assistant markdown to plain prose so TTS doesn't read syntax aloud.
 * Deliberately dumb regexes — code blocks are dropped entirely (reading code
 * aloud is noise), everything else keeps its text content.
 */
export function stripMarkdownForSpeech(markdown: string): string {
  return (
    markdown
      .replace(/^```.*$[\s\S]*?^```[ \t]*$/gm, "") // fenced code blocks
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images → alt text
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1") // links → link text
      .replace(/`([^`]+)`/g, "$1") // inline code → content
      .replace(/^#{1,6}[ \t]+/gm, "") // heading markers
      .replace(/^[ \t]{0,3}>[ \t]?/gm, "") // blockquote markers
      .replace(/^[ \t]*(?:[-*+]|\d+\.)[ \t]+/gm, "") // list markers
      .replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, "") // horizontal rules
      .replace(/(\*\*|__|\*|_)(\S(?:.*?\S)?)\1/g, "$2") // bold/italic markers
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
}
