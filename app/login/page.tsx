"use client";

import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginShell><div className="text-sm text-[#6B6B6B]">Loading…</div></LoginShell>}>
      <LoginForm />
    </Suspense>
  );
}

function LoginShell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen flex items-center justify-center bg-[#F4EEDE] text-[#14172E] p-6">
      <div className="w-full max-w-sm bg-white rounded-lg p-6 shadow-sm border border-black/5">
        <h1 className="font-serif text-2xl mb-1">Field Guide Builder</h1>
        <p className="text-sm text-[#6B6B6B] mb-6">Enter the access password to continue.</p>
        {children}
      </div>
    </main>
  );
}

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/";
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        setError(data.error || "Login failed");
        return;
      }
      router.replace(next);
      router.refresh();
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <LoginShell>
      <form onSubmit={onSubmit}>
        <label className="block text-xs uppercase tracking-wider text-[#6B6B6B] mb-1" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          type="password"
          autoFocus
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="w-full border border-black/15 rounded px-3 py-2 mb-4 focus:outline-none focus:border-[#E8A317]"
        />
        {error ? <p className="text-sm text-red-600 mb-3">{error}</p> : null}
        <button
          type="submit"
          disabled={busy || password.length === 0}
          className="w-full bg-[#0B1027] text-[#F4EEDE] py-2 rounded font-medium disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </LoginShell>
  );
}
