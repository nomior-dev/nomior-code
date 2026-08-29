/**
 * sourceInputs - pure mapping from the seed scenario to broker `SourceInput`s.
 *
 * Kept separate from the seeder so it can be tested without a database: the
 * mapping owns the two things that are easy to get subtly wrong — external-id
 * conventions (the seed's reset key) and evidence spans (character offsets
 * into the canonical text `planChunks` renders).
 *
 * @module nomior/seed/sourceInputs
 */
import { renderSegment } from "../context/Chunking.ts";
import type { EvidenceSpan, NomiorScope, SourceInput, SourceSegment } from "../context/Model.ts";

import {
  SEED_EXTERNAL_ID_PREFIX,
  seedAnarlogAccount,
  seedMeetings,
  seedMemories,
  seedReviewJobs,
  type SeedCapsuleId,
  type SeedMeeting,
  type SeedMemory,
  type SeedReviewJob,
} from "./scenario.ts";

/** Same separator `planChunks` joins rendered segments with. */
const SEGMENT_SEPARATOR = "\n\n";

export const WORK_CAPSULE_SCOPE: NomiorScope = { kind: "capsule", value: "nomior-code" };
export const PERSONAL_CAPSULE_SCOPE: NomiorScope = { kind: "capsule", value: "home-studio" };
export const WORK_PROJECT_SCOPE: NomiorScope = { kind: "project", value: "nomior-code" };

export const capsuleScope = (capsule: SeedCapsuleId): NomiorScope =>
  capsule === "nomior-code" ? WORK_CAPSULE_SCOPE : PERSONAL_CAPSULE_SCOPE;

/**
 * Every seeded source is scoped by its capsule; work sources additionally
 * carry the project scope the scheduler and the sessions use.
 */
const scopesFor = (capsule: SeedCapsuleId): SourceInput["scopes"] =>
  capsule === "nomior-code" ? [WORK_CAPSULE_SCOPE, WORK_PROJECT_SCOPE] : [PERSONAL_CAPSULE_SCOPE];

export const seedExternalId = (kind: string, id: string): string =>
  `${SEED_EXTERNAL_ID_PREFIX}${kind}:${id}`;

export const transcriptExternalId = (meetingId: string): string =>
  seedExternalId("meeting", meetingId);
export const notesExternalId = (meetingId: string): string => seedExternalId("notes", meetingId);
export const memoryExternalId = (memoryId: string): string => seedExternalId("memory", memoryId);
export const reviewSessionExternalId = (jobId: string): string => seedExternalId("review", jobId);

/**
 * Character span of each segment in the canonical text. Mirrors
 * `planChunks`: segments are rendered (speaker prefix included) and joined
 * with a blank line. `sourceInputs.test.ts` asserts the two agree.
 */
export const segmentSpans = (
  segments: ReadonlyArray<SourceSegment>,
): ReadonlyArray<EvidenceSpan> => {
  const spans: Array<EvidenceSpan> = [];
  let offset = 0;
  for (const segment of segments) {
    const rendered = renderSegment(segment);
    spans.push({ charStart: offset, charEnd: offset + rendered.length });
    offset += rendered.length + SEGMENT_SEPARATOR.length;
  }
  return spans;
};

/**
 * Provenance in the shape `ContextIngestAdapter` writes, because that is the
 * shape everything downstream reads: `MeetingStore` finds a meeting by
 * `$.connectorKind` and joins its notes on `$.links.meetingSessionId`. A seed
 * that spelled these its own way would leave the meetings panel empty against
 * seeded data and full against real data.
 *
 * `endedAt` is deliberately absent: the adapter drops it, so a seed carrying it
 * would let a reader derive a duration production cannot.
 */
const meetingProvenance = (
  meeting: SeedMeeting,
  connectorKind: "meeting_transcript" | "meeting_notes",
  externalId: string,
): Record<string, unknown> => ({
  connector: "anarlog",
  accountId: seedAnarlogAccount.accountId,
  externalId,
  connectorKind,
  links: {
    meetingSessionId: meeting.meetingId,
    calendarEventId: meeting.calendarEventId,
    ...(meeting.seriesId === null ? {} : { recurringSeriesId: meeting.seriesId }),
  },
  participants: meeting.participants.map((name) => ({ name })),
});

const transcriptSegments = (meeting: SeedMeeting): ReadonlyArray<SourceSegment> =>
  meeting.transcript.map((turn) => ({
    text: turn.text,
    speaker: turn.speaker,
    tsStart: turn.tsStart,
    tsEnd: turn.tsEnd,
  }));

/** The meeting transcript: the evidence every decision and task points into. */
export const transcriptSource = (meeting: SeedMeeting): SourceInput => {
  const segments = transcriptSegments(meeting);
  const spans = segmentSpans(segments);
  const spanFor = (turnIndex: number): EvidenceSpan | undefined => spans[turnIndex];

  return {
    kind: "meeting",
    externalId: transcriptExternalId(meeting.meetingId),
    title: meeting.title,
    occurredAt: meeting.startsAt,
    scopes: scopesFor(meeting.capsule),
    segments,
    provenance: {
      ...meetingProvenance(meeting, "meeting_transcript", meeting.meetingId),
      language: meeting.language,
    },
    decisions: meeting.decisions.map((decision) => {
      const evidence = spanFor(decision.turnIndex);
      return {
        statement: decision.statement,
        decidedAt: meeting.startsAt,
        ...(evidence === undefined ? {} : { evidence }),
      };
    }),
    tasks: meeting.actionItems.map((item) => {
      const evidence = spanFor(item.turnIndex);
      return {
        description: item.description,
        assignee: item.assignee,
        dueAt: item.dueAt,
        status: item.status,
        ...(evidence === undefined ? {} : { evidence }),
      };
    }),
  };
};

/** Human notes captured next to the transcript, as their own document. */
export const notesSource = (meeting: SeedMeeting): SourceInput => ({
  kind: "document",
  externalId: notesExternalId(meeting.meetingId),
  title: `${meeting.title} — notes`,
  occurredAt: meeting.startsAt,
  scopes: scopesFor(meeting.capsule),
  segments: meeting.notes.map((note) => ({ text: note.text, section: note.section })),
  provenance: meetingProvenance(meeting, "meeting_notes", `${meeting.meetingId}/notes`),
});

export const memorySource = (memory: SeedMemory): SourceInput => ({
  kind: "memory",
  externalId: memoryExternalId(memory.memoryId),
  title: memory.title,
  occurredAt: memory.capturedAt,
  scopes: scopesFor(memory.capsule),
  segments: [{ text: memory.text }],
  provenance: {
    memoryId: memory.memoryId,
    status: memory.status,
    sourceLabel: memory.sourceLabel,
  },
});

/**
 * A finished review, as the session record it leaves behind. Only reviews of
 * a repo that belongs to a seeded capsule are ingested — a board card for
 * another repo has no capsule to be scoped into, and scope-first means no
 * scope, no ingest.
 */
export const reviewSessionSource = (job: SeedReviewJob): SourceInput => ({
  kind: "session",
  externalId: reviewSessionExternalId(job.jobId),
  title: `Review #${job.pullRequestNumber} — ${job.pullRequestTitle}`,
  occurredAt: job.updatedAt,
  scopes: scopesFor("nomior-code"),
  segments: [
    {
      text: `Verdict ${job.verdict ?? "pending"} on ${job.repo} #${job.pullRequestNumber} at ${job.headSha}.`,
      section: "Verdict",
    },
    ...job.findings.map((finding) => ({
      text: `[${finding.severity}] ${finding.summary} (${finding.file}:${finding.line})`,
      section: "Findings",
    })),
    ...job.runtimeEvidence.map((evidence) => ({
      text: `${evidence.kind}: ${evidence.detail}`,
      section: "Runtime evidence",
    })),
  ],
  provenance: {
    reviewJobId: job.jobId,
    repo: job.repo,
    pullRequest: job.pullRequestNumber,
    headSha: job.headSha,
  },
});

const WORK_CAPSULE_REPO = "nomior-dev/nomior-code";

/** Review jobs whose repo is the work capsule's own and that reached a verdict. */
export const ingestableReviewJobs: ReadonlyArray<SeedReviewJob> = seedReviewJobs.filter(
  (job) => job.repo === WORK_CAPSULE_REPO && job.verdict !== null,
);

/** Memories that are established knowledge; candidates await approval. */
export const ingestableMemories: ReadonlyArray<SeedMemory> = seedMemories.filter(
  (memory) => memory.status !== "candidate",
);

export const candidateMemories: ReadonlyArray<SeedMemory> = seedMemories.filter(
  (memory) => memory.status === "candidate",
);

/**
 * Every source the seeder ingests, in a fixed order. Deterministic: the same
 * scenario always yields the same list, ids included.
 */
export const seedSourceInputs: ReadonlyArray<SourceInput> = [
  ...seedMeetings.flatMap((meeting) => [transcriptSource(meeting), notesSource(meeting)]),
  ...ingestableMemories.map(memorySource),
  ...ingestableReviewJobs.map(reviewSessionSource),
];
