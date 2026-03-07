"use client";

interface ApprovalCardProps {
  requestId: string;
  tool: string;
  args: Record<string, unknown>;
  description: string;
  onApprove: (requestId: string) => void;
  onDeny: (requestId: string) => void;
}

export function ApprovalCard({ requestId, tool, args, description, onApprove, onDeny }: ApprovalCardProps) {
  const isOrder = tool === "place_order";
  const isCancel = tool === "cancel_order";

  return (
    <div className="my-3 rounded-xl border border-amber-500/40 bg-amber-950/30 p-4 max-w-md">
      <div className="flex items-center gap-2 mb-3">
        <span className="text-amber-400 text-lg">⚠</span>
        <span className="font-semibold text-amber-300 text-sm uppercase tracking-wide">
          Approval Required
        </span>
      </div>

      <p className="text-gray-200 text-sm mb-3">{description}</p>

      {/* Order details table */}
      {(isOrder || isCancel) && (
        <div className="bg-gray-900/60 rounded-lg p-3 mb-4 text-xs font-mono space-y-1">
          {Object.entries(args).map(([key, value]) => (
            <div key={key} className="flex justify-between gap-4">
              <span className="text-gray-400">{key.replace(/_/g, " ")}</span>
              <span className="text-gray-100 font-medium">{String(value)}</span>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-3">
        <button
          onClick={() => onApprove(requestId)}
          className="flex-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 active:bg-emerald-700 text-white font-semibold py-2 px-4 text-sm transition-colors"
        >
          Approve
        </button>
        <button
          onClick={() => onDeny(requestId)}
          className="flex-1 rounded-lg bg-gray-700 hover:bg-gray-600 active:bg-gray-800 text-gray-200 font-semibold py-2 px-4 text-sm transition-colors"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
