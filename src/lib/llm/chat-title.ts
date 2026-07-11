// Auto-titles a new conversation from its first user message (spec M4 item 2).

export function autoTitle(userText: string, maxLength = 48): string {
  const collapsed = userText.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxLength) return collapsed;
  return `${collapsed.slice(0, maxLength - 1).trimEnd()}…`;
}
