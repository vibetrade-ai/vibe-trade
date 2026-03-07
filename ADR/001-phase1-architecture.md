# ADR-001: Phase 1 Architecture

## Status
Accepted

## Context
Building Phase 1 of VibeTrade: an AI-powered broker app. The MVP goal is to connect a Dhan account via a manually-supplied 24h access token and allow the user to interact with their broker through a Claude-powered chat interface.

## Decisions

### Separate frontend (Next.js) + backend (Fastify)
Two TypeScript projects in a monorepo-style directory.

**Rationale:** Backend owns all broker/AI logic. Next.js stays as a thin UI shell.

### Fastify with WebSockets for the backend
Using `@fastify/websocket` plugin.

**Rationale:** WebSockets enable bidirectional communication required for the structured tool-approval flow — backend can pause mid-tool-call, send an approval request, and wait for the user's Approve/Deny response on the same connection. SSE (server-only push) cannot cleanly support this pattern.

### Structured pause-and-confirm for write operations
Tools that mutate state (`place_order`, `cancel_order`) require user approval before execution. Read-only tools execute immediately.

**Tool approval matrix:**

| Tool | Requires approval? |
|------|--------------------|
| `get_quote` | No |
| `get_index_quote` | No |
| `get_positions` | No |
| `get_funds` | No |
| `get_orders` | No |
| `place_order` | **Yes** |
| `cancel_order` | **Yes** |

### Claude tool use for broker interaction
Claude calls predefined tools. Backend runs the multi-turn tool use loop over a single WS session.

### 24h access token via environment variables
Dhan credentials stored in backend `.env`. No OAuth flow in Phase 1.

### Dhan via REST API (not Python SDK)
The `dhanhq` SDK is Python. TypeScript calls the Dhan REST API directly with `fetch`.

### Parallel execution of read-only tools
When Claude calls multiple read-only tools in a single turn, they are dispatched concurrently and awaited together. Approval-gated tools remain sequential — each requires an explicit user decision before execution.

**Rationale:** Read-only tools have no side effects and no ordering dependency, so parallelising them reduces latency proportionally to the number of concurrent calls. Approval tools cannot be parallelised safely; queuing multiple approval dialogs simultaneously would be confusing and error-prone.

### Single model (claude-sonnet-4-6) throughout
All Claude API calls use Sonnet. A tiered approach (Haiku for read queries, Sonnet for writes) was considered and deferred.

**Rationale:** The entire turn — tool selection, result interpretation, and response — happens in a single API call, so there is no natural mid-turn split point. Routing by intent would require a pre-classification call, adding latency and complexity. More importantly, this is a trading app: unreliable tool use or instruction-following on a cheaper model carries real financial risk. The cost difference per session is small given the short token counts involved.

### Tool errors are passed to Claude, not surfaced directly
When a Dhan API call fails, the error is returned as the tool result so Claude can explain it to the user in plain language. The backend does not terminate the session or send a raw error to the frontend, except for token expiry which also sends a `token_expired` event so the frontend can show a persistent banner.

**Rationale:** Claude can translate technical errors (HTTP status codes, Dhan error codes) into contextual, user-friendly explanations. Direct error surfacing would expose implementation details and produce a worse UX.

## WebSocket Message Protocol

```
// Client → Server
{ type: "message", messages: Message[] }
{ type: "tool_approval_response", requestId: string, approved: boolean }

// Server → Client
{ type: "text_delta", content: string }
{ type: "tool_use_start", tool: string, args: object }
{ type: "tool_use_result", tool: string, result: string, isError: boolean }
{ type: "tool_approval_request", requestId: string, tool: string, args: object, description: string }
{ type: "done" }
{ type: "token_expired" }
{ type: "error", message: string }
```

## Consequences
- Simple architecture, easy to reason about
- No auth complexity in Phase 1
- Token must be refreshed manually every 24h
- Future phases: programmatic token refresh, multi-broker support, tiered model routing
