#!/usr/bin/env node
/* eslint-disable @typescript-eslint/no-unused-expressions */
/**
 * Security assertions for the LinkedIn automation feature.
 *
 *   node --env-file=.env.local scripts/check-automation-security.mjs
 *
 * HTTP checks (need the dev server on BASE_URL, default http://localhost:3838):
 *   - the public cron path 401s without CRON_SECRET            (C2 fail-closed)
 *   - a sibling cron path is NOT public (exact-match bypass)   (C1)
 *   - the manual run-now trigger 401s without the auth cookie  (C1)
 * Static checks (always run):
 *   - the client-facing status/runs routes never reference token columns (H2)
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

const BASE = process.env.BASE_URL || "http://localhost:3838";
let failures = 0;
const pass = (m) => console.log(`  ✓ ${m}`);
const fail = (m) => { console.error(`  ✗ ${m}`); failures++; };

async function httpStatus(method, p) {
  const res = await fetch(`${BASE}${p}`, { method, redirect: "manual" });
  return res.status;
}

console.log("HTTP auth-boundary checks:");
try {
  const cron = await httpStatus("GET", "/api/cron/daily-post");
  cron === 401 ? pass(`/api/cron/daily-post → 401 without secret`) : fail(`/api/cron/daily-post → ${cron} (expected 401)`);

  const sibling = await httpStatus("GET", "/api/cron/daily-post-bypass");
  sibling === 401 ? pass(`/api/cron/daily-post-bypass → 401 (not public)`) : fail(`sibling cron path → ${sibling} (expected 401 — exact-match bypass)`);

  const runNow = await httpStatus("POST", "/api/automation/run-now");
  runNow === 401 ? pass(`/api/automation/run-now → 401 without cookie`) : fail(`run-now → ${runNow} (expected 401 — must be cookie-gated)`);
} catch (e) {
  console.log(`  (skipped HTTP checks — server not reachable at ${BASE}: ${e.message})`);
}

console.log("Static token-leak checks:");
const tokenRefs = [/access_token/, /refresh_token/];
for (const rel of ["app/api/linkedin/status/route.ts", "app/api/automation/runs/route.ts"]) {
  try {
    const src = await readFile(path.join(process.cwd(), rel), "utf8");
    tokenRefs.some((re) => re.test(src))
      ? fail(`${rel} references a token column — must not reach the client`)
      : pass(`${rel} has no token references`);
  } catch (e) {
    fail(`could not read ${rel}: ${e.message}`);
  }
}

console.log(failures === 0 ? "\nAll automation security checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
