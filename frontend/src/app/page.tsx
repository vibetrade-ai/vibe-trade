import { Chat } from "@/components/Chat";
import { ConnectionBadge } from "@/components/ConnectionBadge";

export default function Home() {
  return (
    <div className="flex flex-col h-screen max-w-4xl mx-auto">
      {/* Header */}
      <header className="flex items-center justify-between px-6 py-4 border-b border-gray-800">
        <div className="flex items-center gap-3">
          <span className="text-xl font-bold text-white tracking-tight">VibeTrade</span>
          <span className="text-xs text-gray-500 hidden sm:block">AI-powered broker</span>
        </div>
        <ConnectionBadge />
      </header>

      {/* Chat takes remaining height */}
      <main className="flex-1 overflow-hidden">
        <Chat />
      </main>
    </div>
  );
}
