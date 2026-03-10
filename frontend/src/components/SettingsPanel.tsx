"use client";

import { useState } from "react";
import { useSettings } from "../hooks/useSettings";
import { getBackendHttpUrl } from "@/lib/backend-url";

const CREDENTIAL_FIELDS: { key: "ANTHROPIC_API_KEY" | "DHAN_ACCESS_TOKEN" | "DHAN_CLIENT_ID"; label: string; description: string }[] = [
  { key: "ANTHROPIC_API_KEY", label: "Anthropic API Key", description: "Used to call Claude models" },
  { key: "DHAN_ACCESS_TOKEN", label: "Dhan Access Token", description: "Authenticates with Dhan brokerage" },
  { key: "DHAN_CLIENT_ID", label: "Dhan Client ID", description: "Your Dhan account client ID" },
];

function ConfiguredBadge({ configured }: { configured: boolean }) {
  return configured ? (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-green-900/40 text-green-400 border border-green-800/40">
      Configured
    </span>
  ) : (
    <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-red-900/40 text-red-400 border border-red-800/40">
      Not set
    </span>
  );
}

function CredentialRow({
  label,
  description,
  fieldKey,
  configured,
  onSave,
}: {
  label: string;
  description: string;
  fieldKey: string;
  configured: boolean;
  onSave: (key: string, value: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSave() {
    if (!value.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await onSave(fieldKey, value.trim());
      setValue("");
      setEditing(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="py-3 border-b border-gray-800 last:border-0">
      <div className="flex items-center justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-white">{label}</span>
            <ConfiguredBadge configured={configured} />
          </div>
          <p className="text-xs text-gray-500 mt-0.5">{description}</p>
        </div>
        {!editing && (
          <button
            onClick={() => setEditing(true)}
            className="ml-4 text-xs text-blue-400 hover:text-blue-300 flex-shrink-0"
          >
            {configured ? "Update" : "Set"}
          </button>
        )}
      </div>

      {editing && (
        <div className="mt-2 flex items-center gap-2">
          <input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="Enter new value"
            autoFocus
            className="flex-1 bg-gray-800 border border-gray-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-gray-500 focus:outline-none focus:border-blue-500"
          />
          <button
            onClick={handleSave}
            disabled={saving || !value.trim()}
            className="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-xs font-medium transition-colors"
          >
            {saving ? "..." : "Save"}
          </button>
          <button
            onClick={() => { setEditing(false); setValue(""); setError(null); }}
            className="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 text-gray-300 text-xs transition-colors"
          >
            Cancel
          </button>
        </div>
      )}
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
    </div>
  );
}

export function SettingsPanel({ onSaved }: { onSaved?: () => void } = {}) {
  const { status, allConfigured, loading, save } = useSettings();
  const [testResult, setTestResult] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);

  async function handleSaveField(key: string, value: string) {
    await save({ [key as keyof typeof status]: value });
    onSaved?.();
  }

  async function handleTestConnection() {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch(`${getBackendHttpUrl()}/health`);
      if (res.ok) {
        setTestResult("Backend reachable");
      } else {
        setTestResult(`Backend returned ${res.status}`);
      }
    } catch {
      setTestResult("Cannot reach backend");
    } finally {
      setTesting(false);
    }
  }

  return (
    <div className="flex-1 overflow-y-auto p-6 space-y-6">
      {/* API Credentials */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-white mb-1">API Credentials</h2>
        <p className="text-xs text-gray-500 mb-4">
          Credentials are stored on the server at <code className="text-gray-400">backend/data/credentials.json</code>.
        </p>

        {loading ? (
          <p className="text-sm text-gray-500">Loading...</p>
        ) : (
          <div>
            {CREDENTIAL_FIELDS.map(({ key, label, description }) => (
              <CredentialRow
                key={key}
                label={label}
                description={description}
                fieldKey={key}
                configured={status[key]}
                onSave={handleSaveField}
              />
            ))}
          </div>
        )}
      </div>

      {/* Connection Status */}
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <h2 className="text-sm font-semibold text-white mb-3">Connection Status</h2>
        <div className="space-y-2 mb-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-300">Anthropic (Claude)</span>
            <ConfiguredBadge configured={status.ANTHROPIC_API_KEY} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-300">Dhan Brokerage</span>
            <ConfiguredBadge configured={status.DHAN_ACCESS_TOKEN && status.DHAN_CLIENT_ID} />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm text-gray-300">All services</span>
            <ConfiguredBadge configured={allConfigured} />
          </div>
        </div>
        <button
          onClick={handleTestConnection}
          disabled={testing}
          className="px-3 py-1.5 rounded-lg bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-gray-200 text-xs font-medium transition-colors"
        >
          {testing ? "Testing..." : "Test Connection"}
        </button>
        {testResult && (
          <p className="mt-2 text-xs text-gray-400">{testResult}</p>
        )}
      </div>
    </div>
  );
}
