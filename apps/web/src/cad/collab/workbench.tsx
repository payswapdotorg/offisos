"use client";

/**
 * Offisos Collaboration / Recovery / Scale Workbench — Web host surface
 * (CAD-PARITY-016 / Issue #112).
 *
 * A REAL workflow, not a mockup: the project-scoped member roster with
 * computed presence liveness and server-side permission checks; comments
 * linked to canonical targets (document/element/revision) with resolution
 * lineage; the versioned transactional semantics with the explicit
 * reproducible conflict records and the rebase/discard merge lineage; the
 * durable versioned recovery checkpoints with deterministic crash/session
 * recovery; the durable background-regeneration jobs (one deterministic
 * step per tick); the bounded large-model streaming with the explicit
 * cache non-authority; the fresh external-reference status outcomes; and
 * the revision-bound observable performance budgets. The CADDocument
 * remains the canonical system of record (LOCK-019) — every surface below
 * is a support mechanism bound to canonical revisions/objects.
 */

import * as React from "react";
import {
  Activity,
  MessageSquare,
  RefreshCw,
  Users,
  GitMerge,
  History,
  Layers,
  Gauge,
  FileStack,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";

import {
  collabJoin,
  collabPresence,
  collabComment,
  collabResolveComment,
  collabCommit,
  collabMerge,
  collabState,
  collabComments,
  collabActivity,
  collabTransactions,
  recoveryCheckpoint,
  recoveryRestore,
  recoveryList,
  jobsCreate,
  jobsTick,
  jobsList,
  modelStream,
  modelStreamStats,
  xrefsStatus,
  perfBudgets,
  unwrapCollabState,
  unwrapCollabComments,
  unwrapCollabActivity,
  unwrapCollabTransactions,
  unwrapRecoveryList,
  unwrapJobsList,
  unwrapStreamPage,
  unwrapStreamStats,
  unwrapXrefsStatus,
  unwrapPerfBudgets,
  type CollabMemberRow,
  type CommentRow,
  type ActivityRow,
  type TransactionRow,
  type CheckpointRow,
  type JobRow,
  type StreamPageRow,
  type StreamStatsRow,
  type XrefStatusRow,
  type BudgetsView,
} from "@/cad/client/http-transport";

const INP = "w-full min-w-0 border rounded px-2 py-1 text-sm bg-transparent";

const ROLE_BADGE: Record<string, string> = {
  viewer: "rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-mono text-[10px] text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300",
  commenter: "rounded border border-sky-300 bg-sky-50 px-1.5 py-0.5 font-mono text-[10px] text-sky-700 dark:border-sky-700 dark:bg-sky-950 dark:text-sky-300",
  editor: "rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
};

const STATUS_BADGE: Record<string, string> = {
  applied: "rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  merged: "rounded border border-teal-300 bg-teal-50 px-1.5 py-0.5 font-mono text-[10px] text-teal-700 dark:border-teal-700 dark:bg-teal-950 dark:text-teal-300",
  conflict: "rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300",
  discarded: "rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-mono text-[10px] text-stone-500 line-through dark:border-stone-700 dark:bg-stone-900 dark:text-stone-400",
};

const OUTCOME_BADGE: Record<string, string> = {
  available: "rounded border border-emerald-300 bg-emerald-50 px-1.5 py-0.5 font-mono text-[10px] text-emerald-700 dark:border-emerald-700 dark:bg-emerald-950 dark:text-emerald-300",
  unavailable: "rounded border border-stone-300 bg-stone-50 px-1.5 py-0.5 font-mono text-[10px] text-stone-700 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-300",
  stale: "rounded border border-amber-300 bg-amber-50 px-1.5 py-0.5 font-mono text-[10px] text-amber-700 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-300",
  unsupported: "rounded border border-rose-300 bg-rose-50 px-1.5 py-0.5 font-mono text-[10px] text-rose-700 dark:border-rose-700 dark:bg-rose-950 dark:text-rose-300",
};

const SECTIONS = ["members", "comments", "transactions", "recovery", "jobs", "scale"] as const;
type Section = (typeof SECTIONS)[number];

const SECTION_LABEL: Record<Section, string> = {
  members: "Members & Presence",
  comments: "Comments & Activity",
  transactions: "Transactions & Conflicts",
  recovery: "Recovery",
  jobs: "Background Jobs",
  scale: "Scale & Budgets",
};

export function CollabWorkbench(): React.JSX.Element {
  const [section, setSection] = React.useState<Section>("members");

  // --- members & presence ------------------------------------------------------
  const [members, setMembers] = React.useState<readonly CollabMemberRow[] | null>(null);
  const [presenceMeta, setPresenceMeta] = React.useState<{
    presenceTtl: number;
    clock: number;
    documentVersion: number;
    backend: string;
  } | null>(null);
  const [joinForm, setJoinForm] = React.useState({ userId: "", role: "editor" });
  const [memberError, setMemberError] = React.useState<string | null>(null);
  const [memberBusy, setMemberBusy] = React.useState(false);

  // --- comments + activity --------------------------------------------------------
  const [comments, setComments] = React.useState<readonly CommentRow[] | null>(null);
  const [activity, setActivity] = React.useState<readonly ActivityRow[] | null>(null);
  const [commentForm, setCommentForm] = React.useState({ userId: "", body: "", targetKind: "document", targetRef: "" });
  const [commentError, setCommentError] = React.useState<string | null>(null);
  const [commentBusy, setCommentBusy] = React.useState(false);

  // --- transactions + conflicts -----------------------------------------------------
  const [transactions, setTransactions] = React.useState<readonly TransactionRow[] | null>(null);
  const [txnForm, setTxnForm] = React.useState({ userId: "", elementId: "", baseVersion: "", key: "FireRating", value: "90" });
  const [txnError, setTxnError] = React.useState<string | null>(null);
  const [txnBusy, setTxnBusy] = React.useState(false);
  const [txnMessage, setTxnMessage] = React.useState<string | null>(null);

  // --- recovery -------------------------------------------------------------------
  const [recovery, setRecovery] = React.useState<{ checkpoints: readonly CheckpointRow[]; policy: { autosaveEvery: number; keep: number }; counters: Record<string, number> } | null>(null);
  const [recoveryError, setRecoveryError] = React.useState<string | null>(null);
  const [recoveryBusy, setRecoveryBusy] = React.useState(false);
  const [recoveryReport, setRecoveryReport] = React.useState<string | null>(null);

  // --- jobs ------------------------------------------------------------------------
  const [jobs, setJobs] = React.useState<readonly JobRow[] | null>(null);
  const [jobKind, setJobKind] = React.useState<"docs.regenerate" | "quantity.recalculate" | "model.stream.warm">("quantity.recalculate");
  const [jobError, setJobError] = React.useState<string | null>(null);
  const [jobBusy, setJobBusy] = React.useState(false);

  // --- scale: stream + xrefs + budgets -----------------------------------------------
  const [streamPage, setStreamPage] = React.useState<StreamPageRow | null>(null);
  const [streamStats, setStreamStats] = React.useState<StreamStatsRow | null>(null);
  const [xrefStatus, setXrefStatus] = React.useState<readonly XrefStatusRow[] | null>(null);
  const [budgets, setBudgets] = React.useState<BudgetsView | null>(null);
  const [scaleError, setScaleError] = React.useState<string | null>(null);
  const [scaleBusy, setScaleBusy] = React.useState(false);

  const describeFailure = (res: { ok: boolean; code?: string; message?: string }): string =>
    res.ok ? "unexpected response shape" : `${res.code} — ${res.message}`;

  const refresh = React.useCallback(async (): Promise<void> => {
    const [stateRes, commentsRes, activityRes, txnRes, recRes, jobsRes, xrefRes, budgetRes, statsRes] = await Promise.all([
      collabState(),
      collabComments(),
      collabActivity(),
      collabTransactions(),
      recoveryList(),
      jobsList(),
      xrefsStatus(),
      perfBudgets(),
      modelStreamStats(),
    ]);
    const state = unwrapCollabState(stateRes);
    if (state !== null) {
      setMembers(state.members);
      setPresenceMeta({
        presenceTtl: state.presenceTtl,
        clock: state.clock,
        documentVersion: state.documentVersion,
        backend: state.persistence.backend,
      });
    }
    setComments(unwrapCollabComments(commentsRes));
    setActivity(unwrapCollabActivity(activityRes));
    setTransactions(unwrapCollabTransactions(txnRes));
    const rec = unwrapRecoveryList(recRes);
    if (rec !== null) setRecovery({ checkpoints: rec.checkpoints, policy: rec.policy, counters: rec.counters as unknown as Record<string, number> });
    setJobs(unwrapJobsList(jobsRes));
    setXrefStatus(unwrapXrefsStatus(xrefRes));
    setBudgets(unwrapPerfBudgets(budgetRes));
    setStreamStats(unwrapStreamStats(statsRes));
  }, []);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      await refresh();
      void cancelled;
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // --- members actions -----------------------------------------------------------

  const onJoin = React.useCallback(async (): Promise<void> => {
    setMemberBusy(true);
    setMemberError(null);
    try {
      const res = await collabJoin(joinForm.userId.trim(), joinForm.role as "viewer" | "commenter" | "editor");
      if (!res.ok) setMemberError(describeFailure(res));
      else await refresh();
    } finally {
      setMemberBusy(false);
    }
  }, [joinForm, refresh]);

  const onHeartbeat = React.useCallback(async (userId: string): Promise<void> => {
    setMemberBusy(true);
    setMemberError(null);
    try {
      const res = await collabPresence(userId);
      if (!res.ok) setMemberError(describeFailure(res));
      else await refresh();
    } finally {
      setMemberBusy(false);
    }
  }, [refresh]);

  // --- comment actions --------------------------------------------------------------

  const onComment = React.useCallback(async (): Promise<void> => {
    setCommentBusy(true);
    setCommentError(null);
    try {
      const kind = commentForm.targetKind as "document" | "element" | "revision";
      const target =
        kind === "element"
          ? { kind, id: commentForm.targetRef.trim() }
          : kind === "revision"
            ? { kind, revisionRef: commentForm.targetRef.trim() }
            : { kind };
      const res = await collabComment({ userId: commentForm.userId.trim(), body: commentForm.body, target });
      if (!res.ok) setCommentError(describeFailure(res));
      else {
        setCommentForm((f) => ({ ...f, body: "" }));
        await refresh();
      }
    } finally {
      setCommentBusy(false);
    }
  }, [commentForm, refresh]);

  const onResolve = React.useCallback(async (commentId: string): Promise<void> => {
    setCommentBusy(true);
    setCommentError(null);
    try {
      const res = await collabResolveComment(commentId, commentForm.userId.trim() || "editor");
      if (!res.ok) setCommentError(describeFailure(res));
      else await refresh();
    } finally {
      setCommentBusy(false);
    }
  }, [commentForm.userId, refresh]);

  // --- transaction actions ------------------------------------------------------------

  const onCommit = React.useCallback(async (): Promise<void> => {
    setTxnBusy(true);
    setTxnError(null);
    setTxnMessage(null);
    try {
      const base = Number(txnForm.baseVersion);
      const res = await collabCommit({
        userId: txnForm.userId.trim(),
        baseVersion: Number.isInteger(base) ? base : 0,
        edits: [{ type: "updateElement", elementId: txnForm.elementId.trim(), patch: { [txnForm.key]: Number(txnForm.value) } }],
      });
      if (!res.ok) {
        setTxnError(describeFailure(res));
      } else {
        const v = res.value as { applied: boolean; transaction: TransactionRow };
        setTxnMessage(
          v.applied
            ? `Transaction ${v.transaction.id} applied at base v${v.transaction.baseVersion} → v${v.transaction.resultingVersion}.`
            : `Transaction ${v.transaction.id} CONFLICTED at base v${v.transaction.conflict?.baseVersion} (head v${v.transaction.conflict?.currentVersion}, overlap ${v.transaction.conflict?.overlappingElementIds.length ?? 0}) — resolve through merge.`,
        );
        await refresh();
      }
    } finally {
      setTxnBusy(false);
    }
  }, [txnForm, refresh]);

  const onMerge = React.useCallback(async (transactionId: string, strategy: "rebase" | "discard"): Promise<void> => {
    setTxnBusy(true);
    setTxnError(null);
    setTxnMessage(null);
    try {
      const res = await collabMerge(transactionId, txnForm.userId.trim() || "editor", strategy);
      if (!res.ok) setTxnError(describeFailure(res));
      else {
        const v = res.value as { merge: { mergeId: string; strategy: string; parents: readonly number[]; resultingVersion: number | null } };
        setTxnMessage(
          `Merge ${v.merge.mergeId} (${v.merge.strategy}) reconciled parents [${v.merge.parents.join(", ")}] → v${v.merge.resultingVersion ?? "—"}.`,
        );
        await refresh();
      }
    } finally {
      setTxnBusy(false);
    }
  }, [txnForm.userId, refresh]);

  // --- recovery actions ---------------------------------------------------------------

  const onCheckpoint = React.useCallback(async (): Promise<void> => {
    setRecoveryBusy(true);
    setRecoveryError(null);
    try {
      const res = await recoveryCheckpoint();
      if (!res.ok) setRecoveryError(describeFailure(res));
      else await refresh();
    } finally {
      setRecoveryBusy(false);
    }
  }, [refresh]);

  const onRestore = React.useCallback(async (checkpointId?: string): Promise<void> => {
    setRecoveryBusy(true);
    setRecoveryError(null);
    setRecoveryReport(null);
    try {
      const res = await recoveryRestore(checkpointId);
      if (!res.ok) setRecoveryError(describeFailure(res));
      else {
        const v = res.value as { report: { chosen: CheckpointRow; skipped: { id: string; reason: string }[]; restoredVersionNumber: number } };
        setRecoveryReport(
          `Restored ${v.report.chosen.id} (cause ${v.report.chosen.cause}) → v${v.report.restoredVersionNumber}; ${v.report.skipped.length} skipped.`,
        );
        await refresh();
      }
    } finally {
      setRecoveryBusy(false);
    }
  }, [refresh]);

  // --- jobs actions ----------------------------------------------------------------------

  const onJobCreate = React.useCallback(async (): Promise<void> => {
    setJobBusy(true);
    setJobError(null);
    try {
      const res = await jobsCreate(jobKind);
      if (!res.ok) setJobError(describeFailure(res));
      else await refresh();
    } finally {
      setJobBusy(false);
    }
  }, [jobKind, refresh]);

  const onJobTick = React.useCallback(async (jobId: string): Promise<void> => {
    setJobBusy(true);
    setJobError(null);
    try {
      const res = await jobsTick(jobId);
      if (!res.ok) setJobError(describeFailure(res));
      else await refresh();
    } finally {
      setJobBusy(false);
    }
  }, [refresh]);

  // --- scale actions ---------------------------------------------------------------------

  const onStreamPage = React.useCallback(async (pageIndex: number): Promise<void> => {
    setScaleBusy(true);
    setScaleError(null);
    try {
      const res = await modelStream(pageIndex, 100);
      const page = unwrapStreamPage(res);
      if (page === null) setScaleError(describeFailure(res));
      else setStreamPage(page);
      const statsRes = await modelStreamStats();
      setStreamStats(unwrapStreamStats(statsRes));
    } finally {
      setScaleBusy(false);
    }
  }, []);

  // --- render ---------------------------------------------------------------------------

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto p-3">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex flex-wrap items-center gap-2 text-sm">
            <Users className="h-4 w-4" aria-hidden />
            Collaboration, Recovery &amp; Scale
            <Badge variant="outline" className="font-mono text-[10px]">CAD-PARITY-016</Badge>
            {presenceMeta !== null && (
              <Badge variant="outline" className="font-mono text-[10px]">
                v{presenceMeta.documentVersion} · clock {presenceMeta.clock} · TTL {presenceMeta.presenceTtl}
              </Badge>
            )}
            {presenceMeta !== null && (
              <Badge variant="outline" className="font-mono text-[10px]" aria-label={`P016 persistence backend ${presenceMeta.backend}`}>
                store: {presenceMeta.backend}
              </Badge>
            )}
            <span className="ml-auto flex items-center gap-1">
              <Button size="sm" variant="outline" onClick={() => void refresh()} aria-label="Refresh the P016 surfaces">
                <RefreshCw className="h-3.5 w-3.5" aria-hidden />
              </Button>
            </span>
          </CardTitle>
          <CardDescription className="text-xs">
            The bounded Phase 8 surface: members/presence/comments/activity, versioned transactions with conflict + merge
            lineage, durable recovery checkpoints with deterministic crash recovery, durable background-regeneration
            jobs, bounded large-model streaming (cache never authoritative), fresh external-reference outcomes and the
            revision-bound performance budgets. The document stays the canonical system of record.
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-3">
          <div className="flex flex-wrap gap-1">
            {SECTIONS.map((s) => (
              <Button
                key={s}
                size="sm"
                variant={section === s ? "default" : "outline"}
                onClick={() => setSection(s)}
                aria-current={section === s}
              >
                {SECTION_LABEL[s]}
              </Button>
            ))}
          </div>
        </CardContent>
      </Card>

      {section === "members" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Project members &amp; presence</CardTitle>
            <CardDescription className="text-xs">
              Project-scoped membership with the closed role vocabulary (viewer/commenter/editor — permissions are
              enforced server-side); presence heartbeats with the deterministic session-clock TTL.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 pb-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex w-40 flex-col gap-1 text-xs">
                Member id
                <input
                  className={INP}
                  value={joinForm.userId}
                  onChange={(e) => setJoinForm((f) => ({ ...f, userId: e.target.value }))}
                  placeholder="e.g. ekon"
                  aria-label="Member id"
                />
              </label>
              <label className="flex w-32 flex-col gap-1 text-xs">
                Role
                <select
                  className={INP}
                  value={joinForm.role}
                  onChange={(e) => setJoinForm((f) => ({ ...f, role: e.target.value }))}
                  aria-label="Role"
                >
                  <option value="viewer">viewer</option>
                  <option value="commenter">commenter</option>
                  <option value="editor">editor</option>
                </select>
              </label>
              <Button size="sm" disabled={memberBusy || joinForm.userId.trim().length === 0} onClick={() => void onJoin()}>
                Join
              </Button>
              {memberError !== null && <p className="text-xs text-rose-600">{memberError}</p>}
            </div>
            <Separator />
            <ScrollArea className="max-h-64">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-stone-500">
                    <th className="py-1 pr-2 font-medium">Member</th>
                    <th className="py-1 pr-2 font-medium">Role</th>
                    <th className="py-1 pr-2 font-medium">Joined (clock)</th>
                    <th className="py-1 pr-2 font-medium">Last seen</th>
                    <th className="py-1 pr-2 font-medium">Viewing v</th>
                    <th className="py-1 pr-2 font-medium">Liveness</th>
                    <th className="py-1 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {(members ?? []).map((m) => (
                    <tr key={m.userId} className="border-t border-stone-200 dark:border-stone-800">
                      <td className="py-1 pr-2 font-mono">{m.userId}</td>
                      <td className="py-1 pr-2">
                        <span className={ROLE_BADGE[m.role] ?? ROLE_BADGE.viewer}>{m.role}</span>
                      </td>
                      <td className="py-1 pr-2 font-mono">t={m.joinedAt}</td>
                      <td className="py-1 pr-2 font-mono">{m.lastSeenAt !== null ? `t=${m.lastSeenAt}` : "—"}</td>
                      <td className="py-1 pr-2 font-mono">{m.lastSeenVersion ?? "—"}</td>
                      <td className="py-1 pr-2">
                        <Badge variant={m.active ? "default" : "secondary"} className="font-mono text-[10px]">
                          {m.active ? "active" : "stale"}
                        </Badge>
                      </td>
                      <td className="py-1">
                        <Button size="sm" variant="outline" disabled={memberBusy} onClick={() => void onHeartbeat(m.userId)}>
                          Heartbeat
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {members !== null && members.length === 0 && (
                    <tr>
                      <td colSpan={7} className="py-2 text-stone-500">
                        No members joined this project session yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {section === "comments" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <MessageSquare className="h-4 w-4" aria-hidden />
              Comments &amp; activity
            </CardTitle>
            <CardDescription className="text-xs">
              Comments linked to canonical targets (document/element/revision) with resolution lineage; the bounded
              append-only activity stream.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 pb-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex w-36 flex-col gap-1 text-xs">
                Member id
                <input className={INP} value={commentForm.userId} onChange={(e) => setCommentForm((f) => ({ ...f, userId: e.target.value }))} placeholder="author" aria-label="Comment author" />
              </label>
              <label className="flex min-w-48 flex-1 flex-col gap-1 text-xs">
                Body
                <input className={INP} value={commentForm.body} onChange={(e) => setCommentForm((f) => ({ ...f, body: e.target.value }))} placeholder="Comment body (1..500 chars)" aria-label="Comment body" />
              </label>
              <label className="flex w-32 flex-col gap-1 text-xs">
                Target
                <select className={INP} value={commentForm.targetKind} onChange={(e) => setCommentForm((f) => ({ ...f, targetKind: e.target.value }))} aria-label="Comment target kind">
                  <option value="document">document</option>
                  <option value="element">element</option>
                  <option value="revision">revision</option>
                </select>
              </label>
              <label className="flex w-40 flex-col gap-1 text-xs">
                Target ref
                <input className={INP} value={commentForm.targetRef} onChange={(e) => setCommentForm((f) => ({ ...f, targetRef: e.target.value }))} placeholder="element/revision id" aria-label="Comment target reference" />
              </label>
              <Button size="sm" disabled={commentBusy || commentForm.body.trim().length === 0} onClick={() => void onComment()}>
                Comment
              </Button>
              {commentError !== null && <p className="text-xs text-rose-600">{commentError}</p>}
            </div>
            <Separator />
            <ScrollArea className="max-h-48">
              <ul className="space-y-1 text-xs">
                {(comments ?? []).map((c) => (
                  <li key={c.id} className="flex items-start gap-2 border-b border-stone-100 pb-1 dark:border-stone-900">
                    <span className="font-mono text-stone-500">{c.id}</span>
                    <span className={ROLE_BADGE.viewer}>{c.userId}</span>
                    <span className="flex-1">
                      {c.body}
                      <span className="ml-2 text-stone-400">
                        [{c.target.kind === "element" ? `element ${c.target.id}` : c.target.kind === "revision" ? `revision ${String(c.target.revisionRef).slice(0, 18)}…` : "document"} @ v{c.documentVersion}]
                      </span>
                    </span>
                    {c.resolved ? (
                      <Badge variant="secondary" className="font-mono text-[10px]">resolved by {c.resolvedBy}</Badge>
                    ) : (
                      <Button size="sm" variant="outline" disabled={commentBusy} onClick={() => void onResolve(c.id)}>
                        Resolve
                      </Button>
                    )}
                  </li>
                ))}
                {comments !== null && comments.length === 0 && <li className="text-stone-500">No comments yet.</li>}
              </ul>
            </ScrollArea>
            <Separator />
            <div className="flex items-center gap-2 text-xs font-medium text-stone-500">
              <Activity className="h-3.5 w-3.5" aria-hidden />
              Activity (latest 25)
            </div>
            <ScrollArea className="max-h-48">
              <ul className="space-y-0.5 text-[11px]">
                {(activity ?? []).slice(-25).reverse().map((a) => (
                  <li key={a.seq} className="flex items-baseline gap-2">
                    <span className="w-14 font-mono text-stone-400">t={a.at}</span>
                    <span className="w-40 font-mono text-stone-500">{a.kind}</span>
                    <span className="flex-1">{a.detail}</span>
                  </li>
                ))}
                {activity !== null && activity.length === 0 && <li className="text-stone-500">No activity yet.</li>}
              </ul>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {section === "transactions" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <GitMerge className="h-4 w-4" aria-hidden />
              Versioned transactions, conflicts &amp; merge lineage
            </CardTitle>
            <CardDescription className="text-xs">
              One atomic versioned revision per applied transaction; a stale base produces the explicit reproducible
              conflict (intervening transactions + the overlapping canonical elements); rebase/discard resolutions record
              their lineage (parents = base + head).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 pb-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="flex w-32 flex-col gap-1 text-xs">
                Author
                <input className={INP} value={txnForm.userId} onChange={(e) => setTxnForm((f) => ({ ...f, userId: e.target.value }))} placeholder="member id" aria-label="Transaction author" />
              </label>
              <label className="flex w-36 flex-col gap-1 text-xs">
                Element id
                <input className={INP} value={txnForm.elementId} onChange={(e) => setTxnForm((f) => ({ ...f, elementId: e.target.value }))} placeholder="el-000001" aria-label="Transaction element" />
              </label>
              <label className="flex w-28 flex-col gap-1 text-xs">
                Base version
                <input className={INP} value={txnForm.baseVersion} onChange={(e) => setTxnForm((f) => ({ ...f, baseVersion: e.target.value }))} placeholder="v" aria-label="Transaction base version" />
              </label>
              <label className="flex w-28 flex-col gap-1 text-xs">
                Key
                <input className={INP} value={txnForm.key} onChange={(e) => setTxnForm((f) => ({ ...f, key: e.target.value }))} aria-label="Transaction property key" />
              </label>
              <label className="flex w-24 flex-col gap-1 text-xs">
                Value
                <input className={INP} value={txnForm.value} onChange={(e) => setTxnForm((f) => ({ ...f, value: e.target.value }))} aria-label="Transaction property value" />
              </label>
              <Button size="sm" disabled={txnBusy || txnForm.elementId.trim().length === 0} onClick={() => void onCommit()}>
                Commit
              </Button>
              {txnError !== null && <p className="text-xs text-rose-600">{txnError}</p>}
              {txnMessage !== null && <p className="text-xs text-emerald-700 dark:text-emerald-400">{txnMessage}</p>}
            </div>
            <Separator />
            <ScrollArea className="max-h-72">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-stone-500">
                    <th className="py-1 pr-2 font-medium">Txn</th>
                    <th className="py-1 pr-2 font-medium">Author</th>
                    <th className="py-1 pr-2 font-medium">Base → Result</th>
                    <th className="py-1 pr-2 font-medium">Status</th>
                    <th className="py-1 pr-2 font-medium">Conflict / merge lineage</th>
                    <th className="py-1 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {(transactions ?? []).map((t) => (
                    <tr key={t.id} className="border-t border-stone-200 align-top dark:border-stone-800">
                      <td className="py-1 pr-2 font-mono">{t.id}</td>
                      <td className="py-1 pr-2 font-mono">{t.author}</td>
                      <td className="py-1 pr-2 font-mono">
                        v{t.baseVersion} → {t.resultingVersion !== null ? `v${t.resultingVersion}` : "—"}
                      </td>
                      <td className="py-1 pr-2">
                        <span className={STATUS_BADGE[t.status] ?? STATUS_BADGE.discarded}>{t.status}</span>
                      </td>
                      <td className="py-1 pr-2 text-[11px] text-stone-500">
                        {t.conflict !== null && (
                          <div>
                            conflict [{t.conflict.interveningTransactions.join(", ")}] head v{t.conflict.currentVersion}
                            {t.conflict.overlappingElementIds.length > 0 && <> · overlap [{t.conflict.overlappingElementIds.join(", ")}]</>}
                          </div>
                        )}
                        {t.merge !== null && (
                          <div>
                            merge {t.merge.mergeId} ({t.merge.strategy}) parents [{t.merge.parents.join(", ")}]
                          </div>
                        )}
                      </td>
                      <td className="py-1">
                        {t.status === "conflict" && t.conflict !== null && t.conflict.status === "open" && (
                          <span className="flex gap-1">
                            <Button size="sm" variant="outline" disabled={txnBusy} onClick={() => void onMerge(t.id, "rebase")}>
                              Rebase
                            </Button>
                            <Button size="sm" variant="outline" disabled={txnBusy} onClick={() => void onMerge(t.id, "discard")}>
                              Discard
                            </Button>
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                  {transactions !== null && transactions.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-2 text-stone-500">
                        No transactions recorded in this session yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {section === "recovery" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <History className="h-4 w-4" aria-hidden />
              Recovery checkpoints &amp; deterministic crash recovery
            </CardTitle>
            <CardDescription className="text-xs">
              Durable versioned checkpoints traceable to canonical revisions (document version + content hash + the model
              revision head); the bounded autosave policy; deterministic restore with typed integrity skips — never a
              silent repair.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 pb-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Button size="sm" disabled={recoveryBusy} onClick={() => void onCheckpoint()}>
                Checkpoint
              </Button>
              <Button size="sm" variant="outline" disabled={recoveryBusy} onClick={() => void onRestore()}>
                Recover (latest valid)
              </Button>
              {recovery !== null && (
                <span className="font-mono text-[10px] text-stone-500">
                  policy: autosave every {recovery.policy.autosaveEvery}, keep {recovery.policy.keep} · autosaves {String(recovery.counters.autosaves ?? 0)} · restores {String(recovery.counters.restores ?? 0)} · since-autosave {String(recovery.counters.mutationsSinceAutosave ?? 0)}
                </span>
              )}
              {recoveryError !== null && <p className="text-xs text-rose-600">{recoveryError}</p>}
              {recoveryReport !== null && <p className="text-xs text-emerald-700 dark:text-emerald-400">{recoveryReport}</p>}
            </div>
            <Separator />
            <ScrollArea className="max-h-64">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-stone-500">
                    <th className="py-1 pr-2 font-medium">Checkpoint</th>
                    <th className="py-1 pr-2 font-medium">Cause</th>
                    <th className="py-1 pr-2 font-medium">Doc v</th>
                    <th className="py-1 pr-2 font-medium">Revision</th>
                    <th className="py-1 pr-2 font-medium">Content hash</th>
                    <th className="py-1 pr-2 font-medium">Elements</th>
                    <th className="py-1 pr-2 font-medium">Clock</th>
                    <th className="py-1 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {[...(recovery?.checkpoints ?? [])].reverse().map((c) => (
                    <tr key={c.id} className="border-t border-stone-200 dark:border-stone-800">
                      <td className="py-1 pr-2 font-mono">{c.id}</td>
                      <td className="py-1 pr-2 font-mono">{c.cause}</td>
                      <td className="py-1 pr-2 font-mono">v{c.documentVersionNumber}</td>
                      <td className="py-1 pr-2 font-mono">r{c.modelRevisionNumber}</td>
                      <td className="py-1 pr-2 font-mono text-[10px]">{c.contentHash.slice(0, 12)}…</td>
                      <td className="py-1 pr-2 font-mono">{c.elementCount}</td>
                      <td className="py-1 pr-2 font-mono">t={c.at}</td>
                      <td className="py-1">
                        <Button size="sm" variant="outline" disabled={recoveryBusy} onClick={() => void onRestore(c.id)}>
                          Restore
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {recovery !== null && recovery.checkpoints.length === 0 && (
                    <tr>
                      <td colSpan={8} className="py-2 text-stone-500">
                        No checkpoints captured yet (the autosave policy mints one every 5th version-changing command).
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {section === "jobs" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <FileStack className="h-4 w-4" aria-hidden />
              Durable background-regeneration jobs
            </CardTitle>
            <CardDescription className="text-xs">
              One deterministic step per tick (the serverless-honest durable execution model — no hidden background
              thread); the job output is a revision-bound report; worker output is never authority.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 pb-3">
            <div className="flex flex-wrap items-center gap-2">
              <label className="flex w-56 flex-col gap-1 text-xs">
                Kind
                <select className={INP} value={jobKind} onChange={(e) => setJobKind(e.target.value as typeof jobKind)} aria-label="Job kind">
                  <option value="docs.regenerate">docs.regenerate</option>
                  <option value="quantity.recalculate">quantity.recalculate</option>
                  <option value="model.stream.warm">model.stream.warm</option>
                </select>
              </label>
              <Button size="sm" disabled={jobBusy} onClick={() => void onJobCreate()}>
                Queue job
              </Button>
              {jobError !== null && <p className="text-xs text-rose-600">{jobError}</p>}
            </div>
            <Separator />
            <ScrollArea className="max-h-64">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-stone-500">
                    <th className="py-1 pr-2 font-medium">Job</th>
                    <th className="py-1 pr-2 font-medium">Kind</th>
                    <th className="py-1 pr-2 font-medium">Steps</th>
                    <th className="py-1 pr-2 font-medium">Status</th>
                    <th className="py-1 pr-2 font-medium">Result / failure</th>
                    <th className="py-1 font-medium" />
                  </tr>
                </thead>
                <tbody>
                  {[...(jobs ?? [])].reverse().map((j) => (
                    <tr key={j.id} className="border-t border-stone-200 align-top dark:border-stone-800">
                      <td className="py-1 pr-2 font-mono">{j.id}</td>
                      <td className="py-1 pr-2 font-mono">{j.kind}</td>
                      <td className="py-1 pr-2 font-mono">
                        {j.step}/{j.totalSteps}
                      </td>
                      <td className="py-1 pr-2">
                        <Badge variant={j.status === "succeeded" ? "default" : j.status === "failed" ? "destructive" : "secondary"} className="font-mono text-[10px]">
                          {j.status}
                        </Badge>
                      </td>
                      <td className="py-1 pr-2 text-[11px] text-stone-500">
                        {j.failure !== null ? `${j.failure.code}: ${j.failure.message.slice(0, 60)}` : j.result !== null ? JSON.stringify(j.result.summary).slice(0, 90) : "—"}
                      </td>
                      <td className="py-1">
                        {(j.status === "queued" || j.status === "running") && (
                          <Button size="sm" variant="outline" disabled={jobBusy} onClick={() => void onJobTick(j.id)}>
                            Tick
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                  {jobs !== null && jobs.length === 0 && (
                    <tr>
                      <td colSpan={6} className="py-2 text-stone-500">
                        No durable jobs queued in this session yet.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </ScrollArea>
          </CardContent>
        </Card>
      )}

      {section === "scale" && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Layers className="h-4 w-4" aria-hidden />
              Large-model streaming, external references &amp; budgets
            </CardTitle>
            <CardDescription className="text-xs">
              Canonical id-sorted element pages (version + content-hash bound; the cache is never authoritative — stale
              entries evict with exact accounting); the fresh external-reference outcomes; the revision-bound
              performance budgets.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-2 pb-3">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Button size="sm" disabled={scaleBusy} onClick={() => void onStreamPage(streamPage?.pageIndex ?? 0)}>
                Stream page {streamPage?.pageIndex ?? 0}
              </Button>
              {streamPage !== null && (
                <span className="font-mono text-[10px] text-stone-500">
                  v{streamPage.documentVersionNumber} · {streamPage.contentHash.slice(0, 12)}… · {streamPage.elements.length}/{streamPage.totalElements} elements · page {streamPage.pageIndex + 1}/{streamPage.totalPages} · {streamPage.cacheHit ? "cache hit" : "derived"}
                </span>
              )}
              {scaleError !== null && <p className="text-xs text-rose-600">{scaleError}</p>}
            </div>
            <ScrollArea className="max-h-32">
              <div className="flex flex-wrap gap-1">
                {(streamPage?.elements ?? []).slice(0, 100).map((el) => (
                  <span key={el.id} className="rounded border border-stone-200 px-1 py-0.5 font-mono text-[10px] text-stone-500 dark:border-stone-800">
                    {el.id}
                  </span>
                ))}
              </div>
            </ScrollArea>
            {streamStats !== null && (
              <p className="font-mono text-[10px] text-stone-500">
                cache: {streamStats.entries}/{streamStats.maxEntries} entries · hits {streamStats.hits} · misses {streamStats.misses} · stale evictions {streamStats.staleEvictions} · authoritative: {String(streamStats.authoritative)} (never)
              </p>
            )}
            <Separator />
            <div className="flex items-center gap-2 text-xs font-medium text-stone-500">
              <Gauge className="h-3.5 w-3.5" aria-hidden />
              External references (fresh outcomes)
            </div>
            <ScrollArea className="max-h-40">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-stone-500">
                    <th className="py-1 pr-2 font-medium">Xref</th>
                    <th className="py-1 pr-2 font-medium">Outcome</th>
                    <th className="py-1 font-medium">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {(xrefStatus ?? []).map((x) => (
                    <tr key={x.id} className="border-t border-stone-200 dark:border-stone-800">
                      <td className="py-1 pr-2 font-mono">
                        {x.name} <span className="text-stone-400">({x.entityCount} ent, {x.instances} inst)</span>
                      </td>
                      <td className="py-1 pr-2">
                        <span className={OUTCOME_BADGE[x.outcome] ?? OUTCOME_BADGE.unavailable}>{x.outcome}</span>
                      </td>
                      <td className="py-1 text-[11px] text-stone-500">{x.detail}</td>
                    </tr>
                  ))}
                  {xrefStatus !== null && xrefStatus.length === 0 && (
                    <tr>
                      <td colSpan={3} className="py-2 text-stone-500">
                        No external references attached to this document.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </ScrollArea>
            <Separator />
            {budgets !== null && (
              <div className="space-y-1 text-xs">
                <p className="font-mono text-[10px] text-stone-500">
                  revision-bound: v{budgets.revision.documentVersionNumber} · r{budgets.revision.modelRevisionNumber} · {budgets.revision.contentHash.slice(0, 12)}… · {budgets.revision.elementCount} elements
                </p>
                <div className="flex flex-wrap gap-1">
                  {Object.entries(budgets.counters).map(([k, v]) => (
                    <span key={k} className="rounded border border-stone-200 px-1 py-0.5 font-mono text-[10px] text-stone-500 dark:border-stone-800">
                      {k}={String(v)}
                    </span>
                  ))}
                </div>
                <ScrollArea className="max-h-32">
                  <ul className="space-y-0.5 text-[11px] text-stone-500">
                    {budgets.budgets.map((b) => (
                      <li key={b.workflow} className="flex justify-between gap-2">
                        <span>{b.workflow}</span>
                        <span className="font-mono">≤ {b.thresholdMs} {b.unit} ({b.measuredBy})</span>
                      </li>
                    ))}
                  </ul>
                </ScrollArea>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
