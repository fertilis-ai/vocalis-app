import { useChatStore } from "./chat-store";
import { createCollectionStore } from "./collection-store";
import { useSessionStore } from "./session-store";

// The chat/session sidebar tree (spec §4: chats/tree.json). Leaves are one of
// two kinds — transcription sessions (M3) and voice chats (M4). Deleting a
// leaf removes its backing file(s) via the matching feature store.

export type ChatLeafKind = "session" | "chat";

export const useChatsCollection = createCollectionStore({
  treePath: "~/.vocalis/chats/tree.json",
  guardDeleteLeaf: (id, kind) => {
    if (kind !== "session") return null;
    const status = useSessionStore.getState().sessions[id]?.status;
    if (status === "recording" || status === "processing") {
      return "Can't delete a session while it's recording or processing.";
    }
    return null;
  },
  onDeleteLeaf: async (id, kind) => {
    if (kind === "session") {
      await useSessionStore.getState().removeSession(id);
    } else if (kind === "chat") {
      await useChatStore.getState().removeConversation(id);
    }
  },
});
