import { Suspense } from "react";
import type { Metadata } from "next";
import ApprovalClient from "@/app/_components/ApprovalClient";

// The page is reachable without the password cookie (email-link flow) but is
// useless without a valid single-use token — and must never be indexed.
export const metadata: Metadata = {
  title: "Approve today's post — Field Guide Builder",
  robots: { index: false, follow: false },
};

export default function ApprovePage() {
  return (
    <Suspense fallback={<main className="min-h-screen flex items-center justify-center"><p className="text-sm text-[var(--color-mute)]">Loading…</p></main>}>
      <ApprovalClient />
    </Suspense>
  );
}
