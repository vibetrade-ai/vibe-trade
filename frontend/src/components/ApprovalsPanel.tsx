"use client";

import { useApprovals } from "../hooks/useApprovals";
import { ApprovalItem } from "./ApprovalItem";

// ── Loading skeleton ───────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-gray-700 bg-gray-800/40 p-4 space-y-3 animate-pulse">
      <div className="h-3 bg-gray-700 rounded w-24" />
      <div className="h-4 bg-gray-700 rounded w-40" />
      <div className="h-16 bg-gray-700/60 rounded-lg" />
      <div className="h-3 bg-gray-700 rounded w-full" />
      <div className="h-3 bg-gray-700 rounded w-3/4" />
      <div className="flex gap-2">
        <div className="flex-1 h-9 bg-gray-700 rounded-lg" />
        <div className="flex-1 h-9 bg-gray-700 rounded-lg" />
      </div>
    </div>
  );
}

// ── Panel ──────────────────────────────────────────────────────────────────────

export function ApprovalsPanel() {
  const { approvals, loading, decide } = useApprovals();

  if (loading) {
    return (
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        <SkeletonCard />
        <SkeletonCard />
      </div>
    );
  }

  if (approvals.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center text-center px-6 py-20 space-y-2">
        <div className="w-12 h-12 rounded-full bg-gray-800 flex items-center justify-center mb-2">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="w-6 h-6 text-gray-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={1.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"
            />
          </svg>
        </div>
        <p className="text-gray-300 font-medium text-sm">No pending approvals</p>
        <p className="text-gray-600 text-xs max-w-xs">
          When VibeTrade&apos;s heartbeat agent proposes a trade or creates a new trigger, it will
          appear here for your review.
        </p>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-3">
      {approvals.map((approval) => (
        <ApprovalItem key={approval.id} approval={approval} onDecide={decide} />
      ))}
    </div>
  );
}
