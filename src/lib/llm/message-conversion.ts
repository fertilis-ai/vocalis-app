import type {
  Api,
  AssistantMessage as PiAssistantMessage,
  Message as PiMessage,
  Usage,
} from "@earendil-works/pi-ai";
import type { ChatMessage } from "@/lib/schemas/chat";

// Convert Vocalis ChatMessage[] to pi-ai Message[] for streaming context.
// Trimmed from Sapio's message-conversion.ts: no tool-call handling — voice
// chat (spec M4) has no tool-calling in scope.

function emptyUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export function messagesToPiMessages(
  messages: ChatMessage[],
  api: Api,
  provider: string,
  model: string,
): PiMessage[] {
  const result: PiMessage[] = [];
  for (const message of messages) {
    const timestamp = Date.parse(message.createdAt) || Date.now();
    if (message.role === "user") {
      result.push({ role: "user", content: message.content, timestamp });
      continue;
    }
    const trimmed = message.content.trim();
    if (!trimmed) continue;
    const assistantMessage: PiAssistantMessage = {
      role: "assistant",
      content: [{ type: "text", text: trimmed }],
      api,
      provider,
      model,
      usage: emptyUsage(),
      stopReason: "stop",
      timestamp,
    };
    result.push(assistantMessage);
  }
  return result;
}
