import { ChatWindow } from "@/components/ChatWindow";

export default async function ChatPage({
  searchParams,
}: {
  searchParams: Promise<{ conversationId?: string }>;
}) {
  const { conversationId } = await searchParams;
  return <ChatWindow initialConversationId={conversationId} />;
}
