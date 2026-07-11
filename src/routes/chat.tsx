import { createFileRoute } from "@tanstack/react-router";
import { AppLayout } from "@/components/layout/app-layout";
import { ChatSidebar } from "@/components/chat/chat-sidebar";
import { ChatContent } from "@/components/chat/chat-content";

export const Route = createFileRoute("/chat")({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <AppLayout section="chat" leftPane={<ChatSidebar />}>
      <ChatContent />
    </AppLayout>
  );
}
