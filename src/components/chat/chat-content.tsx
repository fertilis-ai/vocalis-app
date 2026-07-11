import { findNodeInTree } from "@/lib/tree-utils";
import { ChatView } from "@/components/chat/chat-view";
import { SessionView } from "@/components/sessions/session-view";
import { PlaceholderView } from "@/components/shared/placeholder-view";
import { useChatsCollection } from "@/stores/chats-collection";

// Resolves the selected sidebar leaf to its view: transcription sessions render
// the session view (M3 item 5); voice-chat leaves render the chat view (M4).

export function ChatContent() {
  const selectedId = useChatsCollection((s) => s.selectedId);
  const tree = useChatsCollection((s) => s.tree);

  const node = selectedId ? findNodeInTree(tree, selectedId) : null;

  if (!node) {
    return (
      <PlaceholderView
        title="Chat"
        description="Select or start a transcription session or voice chat."
      />
    );
  }

  if (node.kind === "chat") {
    return <ChatView key={node.id} conversationId={node.id} />;
  }

  return <SessionView key={node.id} sessionId={node.id} />;
}
