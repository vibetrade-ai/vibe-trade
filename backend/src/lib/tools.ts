import type Anthropic from "@anthropic-ai/sdk";
import { DhanClient } from "./dhan/client.js";
import { getSecurityId, getSecurityIds } from "./dhan/instruments.js";

export interface ToolDefinition {
  definition: Anthropic.Tool;
  requiresApproval: boolean;
  handler: (args: Record<string, unknown>, client: DhanClient) => Promise<string>;
}

function describeApproval(tool: string, args: Record<string, unknown>): string {
  if (tool === "place_order") {
    return `Place a ${args.transaction_type} order for ${args.quantity} share(s) of ${args.symbol} (${args.order_type}${args.price ? ` @ ₹${args.price}` : ""})`;
  }
  if (tool === "cancel_order") {
    return `Cancel order ID: ${args.order_id}`;
  }
  return `Execute ${tool}`;
}

export function getApprovalDescription(tool: string, args: Record<string, unknown>): string {
  return describeApproval(tool, args);
}

export const TOOLS: Record<string, ToolDefinition> = {
  get_quote: {
    requiresApproval: false,
    definition: {
      name: "get_quote",
      description: "Get live LTP (last traded price) and OHLC for one or more NSE equity symbols.",
      input_schema: {
        type: "object",
        properties: {
          symbols: {
            type: "array",
            items: { type: "string" },
            description: "List of NSE equity trading symbols, e.g. ['RELIANCE', 'TCS', 'INFY']",
          },
        },
        required: ["symbols"],
      },
    },
    handler: async (args, client) => {
      const symbols = args.symbols as string[];
      const secIds = await getSecurityIds(symbols);
      const result = await client.getQuote(Object.values(secIds));
      return JSON.stringify(result, null, 2);
    },
  },

  get_index_quote: {
    requiresApproval: false,
    definition: {
      name: "get_index_quote",
      description: "Get live price for a major Indian index: NIFTY50, BANKNIFTY, or FINNIFTY.",
      input_schema: {
        type: "object",
        properties: {
          index: {
            type: "string",
            description: "Index name. One of: NIFTY50, BANKNIFTY, FINNIFTY",
          },
        },
        required: ["index"],
      },
    },
    handler: async (args, client) => {
      const result = await client.getIndexQuote(args.index as string);
      return JSON.stringify(result, null, 2);
    },
  },

  get_positions: {
    requiresApproval: false,
    definition: {
      name: "get_positions",
      description: "Get all open positions in the Dhan account.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    handler: async (_args, client) => {
      const result = await client.getPositions();
      return JSON.stringify(result, null, 2);
    },
  },

  get_funds: {
    requiresApproval: false,
    definition: {
      name: "get_funds",
      description: "Get available balance, used margin, and day P&L for the Dhan account.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    handler: async (_args, client) => {
      const result = await client.getFunds();
      return JSON.stringify(result, null, 2);
    },
  },

  get_orders: {
    requiresApproval: false,
    definition: {
      name: "get_orders",
      description: "Get today's full order book from the Dhan account.",
      input_schema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    handler: async (_args, client) => {
      const result = await client.getOrders();
      return JSON.stringify(result, null, 2);
    },
  },

  place_order: {
    requiresApproval: true,
    definition: {
      name: "place_order",
      description: "Place a BUY or SELL order on NSE equity. Requires user approval before execution.",
      input_schema: {
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "NSE equity trading symbol, e.g. 'RELIANCE'",
          },
          transaction_type: {
            type: "string",
            enum: ["BUY", "SELL"],
            description: "BUY or SELL",
          },
          quantity: {
            type: "number",
            description: "Number of shares",
          },
          order_type: {
            type: "string",
            enum: ["MARKET", "LIMIT"],
            description: "MARKET or LIMIT order",
          },
          price: {
            type: "number",
            description: "Limit price (required for LIMIT orders, ignored for MARKET)",
          },
        },
        required: ["symbol", "transaction_type", "quantity", "order_type"],
      },
    },
    handler: async (args, client) => {
      const symbol = args.symbol as string;
      const securityId = await getSecurityId(symbol);
      const result = await client.placeOrder({
        symbol,
        securityId,
        transactionType: args.transaction_type as "BUY" | "SELL",
        quantity: args.quantity as number,
        orderType: args.order_type as "MARKET" | "LIMIT",
        price: args.price as number | undefined,
      });
      return JSON.stringify(result, null, 2);
    },
  },

  cancel_order: {
    requiresApproval: true,
    definition: {
      name: "cancel_order",
      description: "Cancel a pending order by order ID. Requires user approval before execution.",
      input_schema: {
        type: "object",
        properties: {
          order_id: {
            type: "string",
            description: "The Dhan order ID to cancel",
          },
        },
        required: ["order_id"],
      },
    },
    handler: async (args, client) => {
      const result = await client.cancelOrder(args.order_id as string);
      return JSON.stringify(result, null, 2);
    },
  },
};

export function getAllToolDefinitions(): Anthropic.Tool[] {
  return Object.values(TOOLS).map((t) => t.definition);
}
