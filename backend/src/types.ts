// WebSocket message types

export type ClientMessage =
  | { type: "message"; messages: ConversationMessage[] }
  | { type: "tool_approval_response"; requestId: string; approved: boolean };

export type ServerMessage =
  | { type: "text_delta"; content: string }
  | { type: "tool_use_start"; tool: string; args: object }
  | { type: "tool_use_result"; tool: string; result: string; isError: boolean }
  | { type: "tool_approval_request"; requestId: string; tool: string; args: object; description: string }
  | { type: "done" }
  | { type: "token_expired" }
  | { type: "error"; message: string };

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}
