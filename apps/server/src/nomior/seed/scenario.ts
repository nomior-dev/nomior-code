/**
 * scenario - the one deterministic Nomior demo dataset.
 *
 * Every timestamp and id in here is a literal: no `Date.now()`, no
 * `Math.random()`, nothing derived from the machine. Re-running the seeder
 * against the same database must produce the same rows, and the web panels'
 * fixtures are generated from this file (see `webFixtures.ts`) so the demo
 * data has exactly one source of truth.
 *
 * The scenario is one working week of building Nomior Code itself
 * (Mon 2026-08-24 → Sat 2026-08-29), across two capsules: the `nomior-code`
 * work capsule and a `home-studio` personal one. The personal capsule exists
 * to make scope isolation testable — a query in one capsule must never
 * surface the other's material.
 *
 * @module nomior/seed/scenario
 */

/** Reference instant the whole scenario is written against (Sat 09:00 UTC). */
export const SEED_NOW = "2026-08-29T09:00:00.000Z";

/** Monday of the scenario week; the web fixtures lay events out relative to it. */
export const SEED_WEEK_START = "2026-08-24T00:00:00.000Z";

/**
 * Marker every seeded context source's external id carries. `--reset` deletes
 * exactly these rows, so a seeded dev database never eats a user's own data.
 */
export const SEED_EXTERNAL_ID_PREFIX = "nomior-seed:";

export type SeedCapsuleId = "nomior-code" | "home-studio";

export interface SeedCapsule {
  readonly capsuleId: SeedCapsuleId;
  readonly label: string;
  readonly kind: "work" | "personal";
  /** Repo the capsule's sessions run in, when it has one. */
  readonly repo: string | null;
  /** Upstream project id the scheduler advises for; null for capsules with no code. */
  readonly projectId: string | null;
}

export const seedCapsules: ReadonlyArray<SeedCapsule> = [
  {
    capsuleId: "nomior-code",
    label: "Nomior Code",
    kind: "work",
    repo: "nomior-dev/nomior-code",
    projectId: "nomior-code",
  },
  {
    capsuleId: "home-studio",
    label: "Home studio",
    kind: "personal",
    repo: null,
    projectId: null,
  },
];

// ---------------------------------------------------------------------------
// Connected accounts
// ---------------------------------------------------------------------------

export interface SeedConnectorAccount {
  readonly accountId: string;
  readonly driverKind: string;
  readonly displayName: string;
  readonly capsule: SeedCapsuleId;
  /** Driver-specific config envelope, stored as JSON by the account store. */
  readonly config: Readonly<Record<string, string>>;
  readonly connectedAt: string;
  readonly updatedAt: string;
  /** One incremental cursor per (account, stream), as a real sync would leave. */
  readonly cursors: ReadonlyArray<{ readonly streamId: string; readonly cursor: string }>;
}

export interface SeedGoogleAccount extends SeedConnectorAccount {
  readonly email: string;
  /** Stable index into the calendar panel's account colour palette. */
  readonly colorIndex: number;
}

/**
 * A Google account is named by its address, never by a role. Connecting one
 * stores the address the provider reports, so a seeded account that called
 * itself "Work calendar" would be the one account in the product wearing a
 * label no real connect can produce.
 */
export const seedGoogleAccounts: ReadonlyArray<SeedGoogleAccount> = [
  {
    accountId: "google-work",
    driverKind: "googleCalendar",
    displayName: "work@nomior.example",
    email: "work@nomior.example",
    capsule: "nomior-code",
    colorIndex: 0,
    config: { calendarId: "work@nomior.example", timeZone: "UTC" },
    connectedAt: "2026-08-10T08:12:00.000Z",
    updatedAt: "2026-08-29T08:55:00.000Z",
    cursors: [{ streamId: "work@nomior.example", cursor: "sync-token-work-0829-0855" }],
  },
  {
    accountId: "google-personal",
    driverKind: "googleCalendar",
    displayName: "personal@gmail.example",
    email: "personal@gmail.example",
    capsule: "home-studio",
    colorIndex: 1,
    config: { calendarId: "personal@gmail.example", timeZone: "UTC" },
    connectedAt: "2026-08-11T19:40:00.000Z",
    updatedAt: "2026-08-29T08:55:00.000Z",
    cursors: [{ streamId: "personal@gmail.example", cursor: "sync-token-personal-0829-0855" }],
  },
];

/** The local transcript store the meetings come from. */
export const seedAnarlogAccount: SeedConnectorAccount = {
  accountId: "anarlog-local",
  driverKind: "anarlog",
  displayName: "Anarlog (this machine)",
  capsule: "nomior-code",
  config: { storePath: "~/Library/Application Support/Anarlog/anarlog.db" },
  connectedAt: "2026-08-09T15:02:00.000Z",
  updatedAt: "2026-08-29T08:56:00.000Z",
  cursors: [{ streamId: "notes", cursor: "anarlog-rowid-4821" }],
};

export const seedConnectorAccounts: ReadonlyArray<SeedConnectorAccount> = [
  ...seedGoogleAccounts,
  seedAnarlogAccount,
];

// ---------------------------------------------------------------------------
// Calendar events
// ---------------------------------------------------------------------------

export interface SeedCalendarEvent {
  readonly eventId: string;
  readonly accountId: string;
  readonly title: string;
  readonly startsAt: string;
  readonly endsAt: string;
  /** Google `recurringEventId`; events sharing one belong to a series. */
  readonly recurringSeriesId: string | null;
  readonly attendees: ReadonlyArray<string>;
  /** The meeting captured against this event, when one was recorded. */
  readonly meetingId: string | null;
}

export const SERIES_DAILY_STANDUP = "series-daily-standup";
export const SERIES_FRIDAY_REVIEW = "series-friday-review";

export const seedCalendarEvents: ReadonlyArray<SeedCalendarEvent> = [
  {
    eventId: "evt-standup-0824",
    accountId: "google-work",
    title: "Daily standup",
    startsAt: "2026-08-24T09:30:00.000Z",
    endsAt: "2026-08-24T09:45:00.000Z",
    recurringSeriesId: SERIES_DAILY_STANDUP,
    attendees: ["ivan@nomior.example", "dasha@nomior.example", "oleg@nomior.example"],
    meetingId: "meet-standup-0824",
  },
  {
    eventId: "evt-standup-0825",
    accountId: "google-work",
    title: "Daily standup",
    startsAt: "2026-08-25T09:30:00.000Z",
    endsAt: "2026-08-25T09:45:00.000Z",
    recurringSeriesId: SERIES_DAILY_STANDUP,
    attendees: ["ivan@nomior.example", "dasha@nomior.example", "oleg@nomior.example"],
    meetingId: "meet-standup-0825",
  },
  {
    // Nobody recorded this one: the series instance exists, the meeting does not.
    eventId: "evt-standup-0826",
    accountId: "google-work",
    title: "Daily standup",
    startsAt: "2026-08-26T09:30:00.000Z",
    endsAt: "2026-08-26T09:45:00.000Z",
    recurringSeriesId: SERIES_DAILY_STANDUP,
    attendees: ["ivan@nomior.example", "dasha@nomior.example", "oleg@nomior.example"],
    meetingId: null,
  },
  {
    eventId: "evt-standup-0827",
    accountId: "google-work",
    title: "Daily standup",
    startsAt: "2026-08-27T09:30:00.000Z",
    endsAt: "2026-08-27T09:45:00.000Z",
    recurringSeriesId: SERIES_DAILY_STANDUP,
    attendees: ["ivan@nomior.example", "dasha@nomior.example", "oleg@nomior.example"],
    meetingId: "meet-standup-0827",
  },
  {
    eventId: "evt-review-engine-0825",
    accountId: "google-work",
    title: "Review engine deep dive",
    startsAt: "2026-08-25T14:00:00.000Z",
    endsAt: "2026-08-25T15:30:00.000Z",
    recurringSeriesId: null,
    attendees: ["ivan@nomior.example", "oleg@nomior.example"],
    meetingId: "meet-review-engine-0825",
  },
  {
    eventId: "evt-anarlog-0826",
    accountId: "google-work",
    title: "Anarlog connector integration",
    startsAt: "2026-08-26T16:00:00.000Z",
    endsAt: "2026-08-26T17:00:00.000Z",
    recurringSeriesId: null,
    attendees: ["ivan@nomior.example", "oleg@nomior.example"],
    meetingId: "meet-anarlog-0826",
  },
  {
    // Last week's instance of the Friday series: history the week grid does
    // not show, which is exactly why it is in the seed.
    eventId: "evt-friday-0821",
    accountId: "google-work",
    title: "Friday review",
    startsAt: "2026-08-21T13:00:00.000Z",
    endsAt: "2026-08-21T14:00:00.000Z",
    recurringSeriesId: SERIES_FRIDAY_REVIEW,
    attendees: ["ivan@nomior.example", "dasha@nomior.example", "oleg@nomior.example"],
    meetingId: "meet-friday-0821",
  },
  {
    eventId: "evt-friday-0828",
    accountId: "google-work",
    title: "Friday review",
    startsAt: "2026-08-28T13:00:00.000Z",
    endsAt: "2026-08-28T14:00:00.000Z",
    recurringSeriesId: SERIES_FRIDAY_REVIEW,
    attendees: ["ivan@nomior.example", "dasha@nomior.example", "oleg@nomior.example"],
    meetingId: "meet-friday-0828",
  },
  {
    eventId: "evt-dentist-0827",
    accountId: "google-personal",
    title: "Dentist",
    startsAt: "2026-08-27T11:00:00.000Z",
    endsAt: "2026-08-27T12:00:00.000Z",
    recurringSeriesId: null,
    attendees: [],
    meetingId: null,
  },
  {
    eventId: "evt-ep-master-0828",
    accountId: "google-personal",
    title: "Mix review — EP master",
    startsAt: "2026-08-28T17:00:00.000Z",
    endsAt: "2026-08-28T18:30:00.000Z",
    recurringSeriesId: null,
    attendees: ["marta@studio.example"],
    meetingId: "meet-ep-master-0828",
  },
];

// ---------------------------------------------------------------------------
// Meetings
// ---------------------------------------------------------------------------

export interface SeedSpeakerTurn {
  readonly speaker: string;
  readonly text: string;
  /** Seconds from the start of the recording. */
  readonly tsStart: number;
  readonly tsEnd: number;
}

export interface SeedDecision {
  readonly statement: string;
  /** Transcript turn the decision was taken in; becomes its evidence span. */
  readonly turnIndex: number;
}

export interface SeedActionItem {
  readonly description: string;
  readonly assignee: string;
  readonly dueAt: string;
  readonly status: "open" | "done" | "dropped";
  readonly turnIndex: number;
}

export interface SeedMeeting {
  readonly meetingId: string;
  readonly capsule: SeedCapsuleId;
  readonly title: string;
  readonly language: "en" | "ru";
  readonly seriesId: string | null;
  readonly calendarEventId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly participants: ReadonlyArray<string>;
  readonly transcript: ReadonlyArray<SeedSpeakerTurn>;
  /** Human notes captured next to the transcript, ingested as their own source. */
  readonly notes: ReadonlyArray<{ readonly section: string; readonly text: string }>;
  readonly decisions: ReadonlyArray<SeedDecision>;
  readonly actionItems: ReadonlyArray<SeedActionItem>;
}

export const seedMeetings: ReadonlyArray<SeedMeeting> = [
  {
    meetingId: "meet-standup-0824",
    capsule: "nomior-code",
    title: "Daily standup",
    language: "en",
    seriesId: SERIES_DAILY_STANDUP,
    calendarEventId: "evt-standup-0824",
    startsAt: "2026-08-24T09:30:00.000Z",
    endsAt: "2026-08-24T09:44:00.000Z",
    participants: ["Ivan", "Dasha", "Oleg"],
    transcript: [
      {
        speaker: "Ivan",
        text: "Retrieval is fused now: BM25 over FTS5 and cosine over the stored vectors, joined with reciprocal rank fusion at k equals sixty. The token budget lands in the same pass.",
        tsStart: 8,
        tsEnd: 26,
      },
      {
        speaker: "Oleg",
        text: "Chunk embedding still runs on the ingest call path in one place. I am moving it behind the queue today so a ninety-minute transcript cannot block a request.",
        tsStart: 26,
        tsEnd: 48,
      },
      {
        speaker: "Dasha",
        text: "I am blocked on the review board copy until the columns are final. If Waiting external stays, the card needs a line naming the human who owns it.",
        tsStart: 48,
        tsEnd: 70,
      },
      {
        speaker: "Ivan",
        text: "Columns are final: Queue, Reviewing, Waiting external, Approved, Not approved. Same names as the engine states, so nobody has to translate between the board and the code.",
        tsStart: 70,
        tsEnd: 94,
      },
    ],
    notes: [
      {
        section: "Retrieval",
        text: "Hybrid retrieval is in: FTS5 BM25 plus dense cosine, fused with RRF at k=60, then a hard token budget. The reranker stays identity until a cross-encoder earns its place.",
      },
      {
        section: "Board",
        text: "Board columns are frozen to the engine states. Waiting external cards always name a human owner.",
      },
    ],
    decisions: [
      {
        statement:
          "The review board's columns mirror the engine's states one to one: Queue, Reviewing, Waiting external, Approved, Not approved.",
        turnIndex: 3,
      },
    ],
    actionItems: [
      {
        description: "Move chunk embedding off the ingest request path into the queue worker",
        assignee: "Oleg",
        dueAt: "2026-08-25T17:00:00.000Z",
        status: "done",
        turnIndex: 1,
      },
      {
        description: "Write the Waiting external card copy, including the owner line",
        assignee: "Dasha",
        dueAt: "2026-08-26T17:00:00.000Z",
        status: "open",
        turnIndex: 2,
      },
    ],
  },
  {
    meetingId: "meet-standup-0825",
    capsule: "nomior-code",
    title: "Daily standup",
    language: "en",
    seriesId: SERIES_DAILY_STANDUP,
    calendarEventId: "evt-standup-0825",
    startsAt: "2026-08-25T09:30:00.000Z",
    endsAt: "2026-08-25T09:43:00.000Z",
    participants: ["Ivan", "Dasha", "Oleg"],
    transcript: [
      {
        speaker: "Ivan",
        text: "The token budget is enforced in one function. Used tokens can never exceed the budget, even when the very first snippet has to be cut in half to fit.",
        tsStart: 6,
        tsEnd: 28,
      },
      {
        speaker: "Oleg",
        text: "Embedding queue is in: one consumer fiber, batches of sixteen, concurrency two, and an awaitIdle the evals can wait on instead of sleeping.",
        tsStart: 28,
        tsEnd: 50,
      },
      {
        speaker: "Dasha",
        text: "All four panels render standalone against the fixture port, so I can iterate on the board without running a server at all.",
        tsStart: 50,
        tsEnd: 68,
      },
      {
        speaker: "Ivan",
        text: "Keep it that way, but the fixtures should be generated out of the seed scenario. Two hand-written copies of the same demo data will drift within a week.",
        tsStart: 68,
        tsEnd: 92,
      },
    ],
    notes: [
      {
        section: "Budget",
        text: "enforceBudget keeps snippets in rank order while they fit and cuts the first snippet rather than returning nothing. usedTokens <= budgetTokens is the invariant.",
      },
      {
        section: "Fixtures",
        text: "Panel fixtures are generated from the seed scenario. The panels keep working standalone; the data behind them stops being a second copy.",
      },
    ],
    decisions: [
      {
        statement:
          "Web panel fixtures are generated from the seed scenario instead of being hand-maintained beside it.",
        turnIndex: 3,
      },
    ],
    actionItems: [
      {
        description: "Generate the apps/web Nomior fixtures from the seed scenario",
        assignee: "Ivan",
        dueAt: "2026-08-29T17:00:00.000Z",
        status: "open",
        turnIndex: 3,
      },
    ],
  },
  {
    meetingId: "meet-standup-0827",
    capsule: "nomior-code",
    title: "Ежедневный статус",
    language: "ru",
    seriesId: SERIES_DAILY_STANDUP,
    calendarEventId: "evt-standup-0827",
    startsAt: "2026-08-27T09:30:00.000Z",
    endsAt: "2026-08-27T09:46:00.000Z",
    participants: ["Иван", "Олег", "Даша"],
    transcript: [
      {
        speaker: "Иван",
        text: "Коннектор Anarlog читает их локальную базу SQLite и markdown-экспорт. В их базу мы не пишем никогда, только читаем.",
        tsStart: 10,
        tsEnd: 32,
      },
      {
        speaker: "Олег",
        text: "Если схема их базы уезжает за протестированный диапазон, коннектор переключается на markdown-фолбэк и показывает статус ожидания обновления, а не падает.",
        tsStart: 32,
        tsEnd: 58,
      },
      {
        speaker: "Даша",
        text: "Тогда в панели коннекторов нужен видимый бейдж, иначе пользователь решит, что всё сломалось и мы молча потеряли его встречи.",
        tsStart: 58,
        tsEnd: 82,
      },
      {
        speaker: "Иван",
        text: "Правило простое: деградация всегда видимая, никогда молчаливая. То же самое для Gmail, когда пользователь ещё не выбрал ярлыки.",
        tsStart: 82,
        tsEnd: 106,
      },
    ],
    notes: [
      {
        section: "Anarlog",
        text: "Читаем только: SQLite плюс markdown-экспорт. Неизвестная схема переводит коннектор в режим awaiting-update с видимым бейджем в UI.",
      },
      {
        section: "Правило",
        text: "Любая деградация коннектора видима в интерфейсе. Молчаливый простой хуже ошибки.",
      },
    ],
    decisions: [
      {
        statement:
          "Неизвестная схема базы Anarlog переводит коннектор в markdown-фолбэк со статусом awaiting-update, а не в ошибку.",
        turnIndex: 1,
      },
    ],
    actionItems: [
      {
        description: "Добавить бейдж awaiting-update в панель коннекторов",
        assignee: "Даша",
        dueAt: "2026-08-31T17:00:00.000Z",
        status: "open",
        turnIndex: 2,
      },
    ],
  },
  {
    meetingId: "meet-review-engine-0825",
    capsule: "nomior-code",
    title: "Review engine deep dive",
    language: "en",
    seriesId: null,
    calendarEventId: "evt-review-engine-0825",
    startsAt: "2026-08-25T14:00:00.000Z",
    endsAt: "2026-08-25T15:28:00.000Z",
    participants: ["Ivan", "Oleg"],
    transcript: [
      {
        speaker: "Ivan",
        text: "The verdict gate is deterministic code. No model output approves a change on its own phrasing; the gate reads parsed findings and decides.",
        tsStart: 15,
        tsEnd: 40,
      },
      {
        speaker: "Oleg",
        text: "Rules as implemented: no legs ran is not approved, an unparseable leg counts as a high finding, any critical or high blocks, medium and low become followups.",
        tsStart: 40,
        tsEnd: 70,
      },
      {
        speaker: "Ivan",
        text: "Two more preconditions before anything is approved: the repo has a playbook, and at least one leg reported real runtime evidence. A review with zero evidence is an opinion, not a verification.",
        tsStart: 70,
        tsEnd: 106,
      },
      {
        speaker: "Oleg",
        text: "Retries back off exponentially on the attempt count, and a rate-limited leg backs off from an hour instead of five minutes so a throttled instance is left alone.",
        tsStart: 106,
        tsEnd: 138,
      },
      {
        speaker: "Ivan",
        text: "External posting stays behind allowExternalPosting and defaults to off. The verdict is local until the user says otherwise.",
        tsStart: 138,
        tsEnd: 162,
      },
    ],
    notes: [
      {
        section: "Gate",
        text: "Fail-closed: no legs, unparseable output, or any critical/high finding all end in not approved. Approval additionally requires a playbook and one runtime-evidence entry.",
      },
      {
        section: "Retries",
        text: "Exponential backoff on attempts; rate-limit failures use the hour-scale base. After maxAttempts the job lands in failed with the reason recorded.",
      },
      {
        section: "Posting",
        text: "Nothing is posted to a forge unless allowExternalPosting is explicitly turned on.",
      },
    ],
    decisions: [
      {
        statement:
          "Approving a review requires a repo playbook and at least one piece of runtime evidence; either missing caps the verdict at not approved.",
        turnIndex: 2,
      },
      {
        statement:
          "External posting of verdicts stays opt-in and defaults to off; verdicts are local until the user approves posting.",
        turnIndex: 4,
      },
    ],
    actionItems: [
      {
        description: "Cover the unparseable-leg case in the gate tests",
        assignee: "Oleg",
        dueAt: "2026-08-26T17:00:00.000Z",
        status: "done",
        turnIndex: 1,
      },
    ],
  },
  {
    meetingId: "meet-anarlog-0826",
    capsule: "nomior-code",
    title: "Anarlog connector integration",
    language: "en",
    seriesId: null,
    calendarEventId: "evt-anarlog-0826",
    startsAt: "2026-08-26T16:00:00.000Z",
    endsAt: "2026-08-26T16:58:00.000Z",
    participants: ["Ivan", "Oleg"],
    transcript: [
      {
        speaker: "Oleg",
        text: "Calendar sync is incremental on the sync token. A 410 GONE means the token expired: we drop it, do a full resync, and the batch comes back with cursorInvalidated so the caller treats it as a baseline rather than a delta.",
        tsStart: 20,
        tsEnd: 58,
      },
      {
        speaker: "Ivan",
        text: "Gmail is opt-in per label, sender or thread. We never sync a whole mailbox — that is a restricted scope and it drags Google verification and an annual assessment behind it.",
        tsStart: 58,
        tsEnd: 92,
      },
      {
        speaker: "Oleg",
        text: "Meeting assembly joins a transcript to its calendar event by the stored event id first, and only falls back to time overlap, title similarity and participant overlap when there is no link.",
        tsStart: 92,
        tsEnd: 128,
      },
      {
        speaker: "Ivan",
        text: "And when two candidates sit inside the ambiguity margin we mark the meeting needs-confirmation and show both. Attaching the wrong meeting is worse than asking a question.",
        tsStart: 128,
        tsEnd: 160,
      },
    ],
    notes: [
      {
        section: "Calendar",
        text: "Incremental sync tokens; 410 GONE triggers a full resync and sets cursorInvalidated on the batch.",
      },
      {
        section: "Gmail",
        text: "Strictly opt-in selectors: chosen labels, senders or threads. Never the whole mailbox.",
      },
      {
        section: "Matching",
        text: "Explicit cross-store link wins; heuristics only as fallback; ambiguous matches ask instead of guessing.",
      },
    ],
    decisions: [
      {
        statement:
          "An ambiguous transcript-to-event match is surfaced for confirmation instead of being guessed.",
        turnIndex: 3,
      },
    ],
    actionItems: [
      {
        description: "Wire cursorInvalidated from the calendar driver into the sync daemon",
        assignee: "Oleg",
        dueAt: "2026-08-31T17:00:00.000Z",
        status: "open",
        turnIndex: 0,
      },
    ],
  },
  {
    meetingId: "meet-friday-0821",
    capsule: "nomior-code",
    title: "Friday review",
    language: "en",
    seriesId: SERIES_FRIDAY_REVIEW,
    calendarEventId: "evt-friday-0821",
    startsAt: "2026-08-21T13:00:00.000Z",
    endsAt: "2026-08-21T13:52:00.000Z",
    participants: ["Ivan", "Dasha", "Oleg"],
    transcript: [
      {
        speaker: "Ivan",
        text: "Week one of the fork is done. Upstream history is merged, the manifest checker is green, and every file we added lives under a nomior path.",
        tsStart: 12,
        tsEnd: 40,
      },
      {
        speaker: "Oleg",
        text: "Our migrations track in their own tables, so upstream can keep appending numeric ids to theirs without ever colliding with ours during a sync.",
        tsStart: 40,
        tsEnd: 68,
      },
      {
        speaker: "Dasha",
        text: "The landing page is dark only. That decision is made; I am not re-litigating it every Friday.",
        tsStart: 68,
        tsEnd: 86,
      },
      {
        speaker: "Ivan",
        text: "Agreed. Next week is the context broker end to end, then the review engine on top of it.",
        tsStart: 86,
        tsEnd: 108,
      },
    ],
    notes: [
      {
        section: "Fork",
        text: "Additive-only discipline holds: upstream files are touched for registration lines only, each recorded in the fork manifest.",
      },
      {
        section: "Next",
        text: "Context broker end to end, then the review engine.",
      },
    ],
    decisions: [
      {
        statement:
          "Nomior migrations track in their own migration tables so upstream migration ids never collide with ours.",
        turnIndex: 1,
      },
    ],
    actionItems: [
      {
        description: "Ship the context broker end to end: ingest, retrieval, budget, citations",
        assignee: "Ivan",
        dueAt: "2026-08-28T17:00:00.000Z",
        status: "done",
        turnIndex: 3,
      },
    ],
  },
  {
    meetingId: "meet-friday-0828",
    capsule: "nomior-code",
    title: "Friday review",
    language: "en",
    seriesId: SERIES_FRIDAY_REVIEW,
    calendarEventId: "evt-friday-0828",
    startsAt: "2026-08-28T13:00:00.000Z",
    endsAt: "2026-08-28T13:55:00.000Z",
    participants: ["Ivan", "Dasha", "Oleg"],
    transcript: [
      {
        speaker: "Ivan",
        text: "Six tracks merged this morning: context engine, connectors, scheduler, review engine, the MCP toolkit and the web panels.",
        tsStart: 10,
        tsEnd: 34,
      },
      {
        speaker: "Oleg",
        text: "The scheduler reads only the rate-limit events the provider CLIs already emit. No keychain, no provider home directories, no usage endpoint polling — there is a test that greps for exactly that.",
        tsStart: 34,
        tsEnd: 72,
      },
      {
        speaker: "Dasha",
        text: "Board, calendar, context and instances all render. What they need now is real data behind them instead of four hand-written fixture files.",
        tsStart: 72,
        tsEnd: 98,
      },
      {
        speaker: "Ivan",
        text: "That is the seed: one scenario, one database, and a simulation that proves the budget cap and the verdict gate actually hold before we demo anything.",
        tsStart: 98,
        tsEnd: 128,
      },
    ],
    notes: [
      {
        section: "Merged",
        text: "Six tracks are on main: context engine, connectors, scheduler, review engine, MCP toolkit, web panels.",
      },
      {
        section: "Credentials",
        text: "The scheduler never reads credentials. Its only input is the rate-limit events the CLIs already emit, and a test asserts the isolation.",
      },
      {
        section: "Seed",
        text: "One seeded scenario plus a simulation harness is the acceptance surface for the merged tracks.",
      },
    ],
    decisions: [
      {
        statement:
          "The scheduler stays credential-free: its only input is the rate-limit events the provider CLIs already emit — no keychain, no provider home directories, no usage polling.",
        turnIndex: 1,
      },
      {
        statement:
          "A seeded scenario plus a simulation harness is the acceptance surface for the merged tracks: no demo without a passing simulation.",
        turnIndex: 3,
      },
    ],
    actionItems: [
      {
        description: "Build the seed scenario and the simulation harness",
        assignee: "Ivan",
        dueAt: "2026-08-29T18:00:00.000Z",
        status: "open",
        turnIndex: 3,
      },
      {
        description: "Point the web panels at the generated fixtures",
        assignee: "Dasha",
        dueAt: "2026-08-30T17:00:00.000Z",
        status: "open",
        turnIndex: 2,
      },
    ],
  },
  {
    meetingId: "meet-ep-master-0828",
    capsule: "home-studio",
    title: "Mix review — EP master",
    language: "en",
    seriesId: null,
    calendarEventId: "evt-ep-master-0828",
    startsAt: "2026-08-28T17:00:00.000Z",
    endsAt: "2026-08-28T18:22:00.000Z",
    participants: ["Ivan", "Marta"],
    transcript: [
      {
        speaker: "Ivan",
        text: "The master came back two decibels hotter than the reference. It clips on a phone speaker in the last chorus, which is exactly where the song is supposed to open up.",
        tsStart: 25,
        tsEnd: 58,
      },
      {
        speaker: "Marta",
        text: "I will pull the limiter back and send a new master on Tuesday. The vinyl cut needs its own quieter version anyway, so I will render both.",
        tsStart: 58,
        tsEnd: 92,
      },
      {
        speaker: "Ivan",
        text: "Keep the ISRC codes from the previous delivery. The distributor already registered them and re-registering would split the royalty reporting.",
        tsStart: 92,
        tsEnd: 124,
      },
    ],
    notes: [
      {
        section: "Master",
        text: "Current master is roughly two decibels hot and clips on small speakers in the final chorus. Re-limit and re-render.",
      },
      {
        section: "Delivery",
        text: "Reuse the registered ISRC codes; a separate quieter render goes to the vinyl cut.",
      },
    ],
    decisions: [
      {
        statement:
          "Ship the EP with the re-limited quieter master and keep the ISRC codes already registered with the distributor.",
        turnIndex: 1,
      },
    ],
    actionItems: [
      {
        description: "Send the re-limited EP master and the separate vinyl render",
        assignee: "Marta",
        dueAt: "2026-09-01T17:00:00.000Z",
        status: "open",
        turnIndex: 1,
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Memory
// ---------------------------------------------------------------------------

/**
 * `verified` and `procedural` memories are established knowledge and are
 * ingested into the broker. `candidate` memories are NOT: they wait for an
 * explicit decision, and the simulator asserts they never surface in
 * retrieval (PLAN.md — nothing promotes without approval).
 */
export type SeedMemoryStatus = "verified" | "candidate" | "procedural";

export interface SeedMemory {
  readonly memoryId: string;
  readonly capsule: SeedCapsuleId;
  readonly status: SeedMemoryStatus;
  readonly title: string;
  readonly text: string;
  readonly capturedAt: string;
  /** Where the memory came from, as shown next to it in the panel. */
  readonly sourceLabel: string;
  /** Which producer offered it — the candidate store's two-value vocabulary. */
  readonly producer: "review" | "context-tool";
}

export const seedMemories: ReadonlyArray<SeedMemory> = [
  {
    memoryId: "mem-501",
    capsule: "nomior-code",
    status: "candidate",
    title: "Ingest cursors must be idempotent",
    text: "Ingest cursor writes must be idempotent: derive the cursor key from the batch id, never from wall-clock time, or a replayed batch double-advances the sync window.",
    capturedAt: "2026-08-29T04:00:00.000Z",
    sourceLabel: "Review #388 — nomior-dev/nomior-invest",
    producer: "review",
  },
  {
    memoryId: "mem-502",
    capsule: "nomior-code",
    status: "candidate",
    title: "Waiting external cards name an owner",
    text: "Cards in the Waiting external column always name the human who owns the next step; a card with no owner is a queue with extra steps.",
    capturedAt: "2026-08-28T13:20:00.000Z",
    sourceLabel: "Friday review — 2026-08-28",
    producer: "context-tool",
  },
  {
    memoryId: "mem-503",
    capsule: "nomior-code",
    status: "candidate",
    title: "Scheduler picks are explained in the UI",
    text: "Every automatic instance pick names its signal in user-facing copy: manual pin, project constraint, sticky, headroom, or rotation.",
    capturedAt: "2026-08-27T11:05:00.000Z",
    sourceLabel: "PLAN.md — instance scheduler",
    producer: "context-tool",
  },
  {
    memoryId: "mem-504",
    capsule: "nomior-code",
    status: "verified",
    title: "The verdict gate is deterministic code",
    text: "The review verdict gate is deterministic code, never a model: it reads parsed leg findings and decides. Any critical or high finding blocks approval, and an unparseable leg counts as high.",
    capturedAt: "2026-08-25T15:30:00.000Z",
    sourceLabel: "Review engine deep dive — 2026-08-25",
    producer: "context-tool",
  },
  {
    memoryId: "mem-505",
    capsule: "nomior-code",
    status: "verified",
    title: "Nomior migrations track separately",
    text: "Nomior migrations track in their own tables (nomior_sql_migrations, nomior_connector_migrations) so upstream can keep appending migration ids without colliding with the fork.",
    capturedAt: "2026-08-21T14:00:00.000Z",
    sourceLabel: "Friday review — 2026-08-21",
    producer: "context-tool",
  },
  {
    memoryId: "mem-506",
    capsule: "nomior-code",
    status: "verified",
    title: "Retrieval enforces a hard token budget",
    text: "Context retrieval enforces a hard token budget: used tokens never exceed the requested budget, and a truncated answer tells the caller to narrow the query instead of silently dropping evidence.",
    capturedAt: "2026-08-25T09:45:00.000Z",
    sourceLabel: "Daily standup — 2026-08-25",
    producer: "context-tool",
  },
  {
    memoryId: "mem-507",
    capsule: "nomior-code",
    status: "verified",
    title: "Connector degradation is visible",
    text: "A connector that cannot read its source degrades visibly: Anarlog falls back to the markdown export with an awaiting-update badge, Gmail refuses to sync until selectors are chosen. Silent idling is never acceptable.",
    capturedAt: "2026-08-27T09:46:00.000Z",
    sourceLabel: "Ежедневный статус — 2026-08-27",
    producer: "context-tool",
  },
  {
    memoryId: "mem-508",
    capsule: "nomior-code",
    status: "procedural",
    title: "Running the retrieval eval",
    text: "Run the retrieval eval with pnpm --filter t3 nomior:eval-retrieval. The recall gates are floors: raise them after an improvement, never lower them to make a run pass.",
    capturedAt: "2026-08-26T08:00:00.000Z",
    sourceLabel: "docs/nomior/WORKING-RULES.md",
    producer: "context-tool",
  },
  {
    memoryId: "mem-509",
    capsule: "nomior-code",
    status: "procedural",
    title: "Fork discipline for upstream files",
    text: "Our code is additive. An upstream file is touched only for a registration line, and every such touch is recorded in docs/nomior/FORK-MANIFEST.md or CI fails the manifest check.",
    capturedAt: "2026-08-20T10:00:00.000Z",
    sourceLabel: "docs/nomior/WORKING-RULES.md",
    producer: "context-tool",
  },
  {
    memoryId: "mem-510",
    capsule: "home-studio",
    status: "procedural",
    title: "Studio delivery loudness",
    text: "Studio exports go out at minus fourteen LUFS integrated with one decibel of true-peak headroom; the distributor rejects anything hotter and the vinyl cut always gets its own quieter render.",
    capturedAt: "2026-08-28T18:30:00.000Z",
    sourceLabel: "Mix review — EP master",
    producer: "context-tool",
  },
];

// ---------------------------------------------------------------------------
// Provider instances and rate limits
// ---------------------------------------------------------------------------

/**
 * Provider instances themselves live in server settings (the user signs each
 * one in), which the seeder deliberately does not write. What the seeder does
 * write is their observable state: the rate-limit headroom the scheduler
 * reasons over.
 */
export interface SeedProviderInstance {
  readonly instanceId: string;
  readonly label: string;
  /** Display name of the provider, as the instances panel shows it. */
  readonly provider: string;
  readonly driverKind: string;
  readonly health: "healthy" | "throttled" | "signed-out";
  /** Utilization of the most constrained window, 0..100; null when unknown. */
  readonly usedPercent: number | null;
  readonly rateLimitStatus: "ok" | "warning" | "limited" | null;
  readonly resetsAt: string | null;
  readonly observedAt: string;
}

export const seedProviderInstances: ReadonlyArray<SeedProviderInstance> = [
  {
    instanceId: "inst-claude-main",
    label: "Claude — main",
    provider: "Claude",
    driverKind: "claudeAgent",
    health: "healthy",
    usedPercent: 28,
    rateLimitStatus: "ok",
    resetsAt: "2026-08-29T13:00:00.000Z",
    observedAt: "2026-08-29T08:40:00.000Z",
  },
  {
    instanceId: "inst-claude-alt",
    label: "Claude — studio",
    provider: "Claude",
    driverKind: "claudeAgent",
    health: "throttled",
    usedPercent: 94,
    rateLimitStatus: "limited",
    resetsAt: "2026-08-29T18:00:00.000Z",
    observedAt: "2026-08-29T08:47:00.000Z",
  },
  {
    instanceId: "inst-codex-main",
    label: "Codex — main",
    provider: "Codex",
    driverKind: "codex",
    health: "healthy",
    usedPercent: 45,
    rateLimitStatus: "ok",
    resetsAt: "2026-08-29T16:00:00.000Z",
    observedAt: "2026-08-29T08:42:00.000Z",
  },
  {
    // Signed out: no rate-limit signal exists for an instance nobody is using.
    instanceId: "inst-grok",
    label: "Grok",
    provider: "Grok",
    driverKind: "grok",
    health: "signed-out",
    usedPercent: null,
    rateLimitStatus: null,
    resetsAt: null,
    observedAt: "2026-08-28T21:00:00.000Z",
  },
];

/** Sticky per-project assignment a previous session left behind. */
export const seedSchedulerAssignment = {
  projectId: "nomior-code",
  instanceId: "inst-claude-main",
  updatedAt: "2026-08-29T08:41:00.000Z",
} as const;

// ---------------------------------------------------------------------------
// Review jobs
// ---------------------------------------------------------------------------

export type SeedFindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export interface SeedFinding {
  readonly severity: SeedFindingSeverity;
  readonly summary: string;
  readonly file: string;
  readonly line: number;
}

export interface SeedRuntimeEvidence {
  readonly kind: "tests-run" | "build-passed" | "typecheck-passed" | "live-probe" | "ci-green";
  readonly detail: string;
}

export interface SeedReviewJob {
  readonly jobId: string;
  readonly repo: string;
  readonly pullRequestNumber: number;
  readonly pullRequestTitle: string;
  readonly headSha: string;
  readonly riskTier: "low" | "medium" | "high";
  readonly status: "queued" | "reviewing" | "waiting-external" | "approved" | "not-approved";
  /** Where the pull request itself stands. The board lists `open` only. */
  readonly pullRequestState: "open" | "merged" | "closed";
  readonly verdict: "approve" | "approve-with-followups" | "not-approved" | null;
  readonly manualReviewRequested: boolean;
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastStartedAt: string | null;
  readonly failureReason: string | null;
  readonly findings: ReadonlyArray<SeedFinding>;
  readonly runtimeEvidence: ReadonlyArray<SeedRuntimeEvidence>;
}

export const seedReviewJobs: ReadonlyArray<SeedReviewJob> = [
  {
    jobId: "rev-101",
    repo: "nomior-dev/nomior-code",
    pullRequestNumber: 412,
    pullRequestTitle: "feat(server): context broker retrieval pipeline",
    headSha: "4f2a9c1",
    riskTier: "high",
    status: "queued",
    pullRequestState: "open",
    verdict: null,
    manualReviewRequested: false,
    attempts: 0,
    createdAt: "2026-08-29T08:30:00.000Z",
    updatedAt: "2026-08-29T08:36:00.000Z",
    lastStartedAt: null,
    failureReason: null,
    findings: [],
    runtimeEvidence: [],
  },
  {
    jobId: "rev-102",
    repo: "nomior-dev/nomior-invest",
    pullRequestNumber: 388,
    pullRequestTitle: "fix(pipeline): dedupe filings ingest cursors",
    headSha: "8b13e7d",
    riskTier: "medium",
    status: "queued",
    pullRequestState: "open",
    verdict: null,
    manualReviewRequested: false,
    attempts: 0,
    createdAt: "2026-08-29T07:40:00.000Z",
    updatedAt: "2026-08-29T07:48:00.000Z",
    lastStartedAt: null,
    failureReason: null,
    findings: [],
    runtimeEvidence: [],
  },
  {
    jobId: "rev-103",
    repo: "nomior-dev/nomior-code",
    pullRequestNumber: 409,
    pullRequestTitle: "feat(web): instances panel scheduler surface",
    headSha: "c07d4aa",
    riskTier: "medium",
    status: "reviewing",
    pullRequestState: "open",
    verdict: null,
    manualReviewRequested: false,
    attempts: 1,
    createdAt: "2026-08-29T08:20:00.000Z",
    updatedAt: "2026-08-29T08:54:00.000Z",
    lastStartedAt: "2026-08-29T08:54:00.000Z",
    failureReason: null,
    findings: [
      {
        severity: "high",
        summary:
          "Headroom renders before the scheduler has any signal, so a fresh instance shows 100% instead of unknown.",
        file: "apps/web/src/nomior/InstancesPanel.tsx",
        line: 88,
      },
      {
        severity: "medium",
        summary:
          "The pin toggle sends a request per click with no debounce; a double click sends two conflicting pins.",
        file: "apps/web/src/nomior/InstancesPanel.tsx",
        line: 121,
      },
      {
        severity: "medium",
        summary:
          "The scheduler reason is truncated with CSS only, so the full explanation is unreachable on narrow panels.",
        file: "apps/web/src/nomior/InstancesPanel.tsx",
        line: 143,
      },
    ],
    runtimeEvidence: [{ kind: "typecheck-passed", detail: "tsgo --noEmit clean in apps/web" }],
  },
  {
    jobId: "rev-104",
    repo: "nomior-dev/nomior-music",
    pullRequestNumber: 96,
    pullRequestTitle: "feat(catalog): ISRC dedupe pass over delivery feeds",
    headSha: "51ff902",
    riskTier: "high",
    status: "waiting-external",
    pullRequestState: "open",
    verdict: null,
    manualReviewRequested: true,
    attempts: 1,
    createdAt: "2026-08-29T05:30:00.000Z",
    updatedAt: "2026-08-29T06:00:00.000Z",
    lastStartedAt: "2026-08-29T05:44:00.000Z",
    failureReason: null,
    findings: [
      {
        severity: "critical",
        summary:
          "The dedupe pass deletes delivery rows before the new ISRC mapping commits; a failed commit loses catalogue rows with no way back.",
        file: "apps/server/src/catalog/isrcDedupe.ts",
        line: 214,
      },
      {
        severity: "high",
        summary:
          "Duplicate detection compares ISRC strings case-sensitively, so recordings differing only in case survive the pass.",
        file: "apps/server/src/catalog/isrcDedupe.ts",
        line: 96,
      },
    ],
    runtimeEvidence: [
      { kind: "live-probe", detail: "dry run over 12k delivery rows, 38 duplicates detected" },
    ],
  },
  {
    jobId: "rev-105",
    repo: "nomior-dev/nomior-code",
    pullRequestNumber: 401,
    pullRequestTitle: "chore(fork): daily upstream sync",
    headSha: "a91c3f5",
    riskTier: "low",
    status: "approved",
    pullRequestState: "open",
    verdict: "approve-with-followups",
    manualReviewRequested: false,
    attempts: 1,
    createdAt: "2026-08-29T02:15:00.000Z",
    updatedAt: "2026-08-29T03:00:00.000Z",
    lastStartedAt: "2026-08-29T02:31:00.000Z",
    failureReason: null,
    findings: [
      {
        severity: "low",
        summary:
          "The sync PR body lists manifest'd files unsorted, so the body churns between otherwise identical runs.",
        file: "scripts/nomior/upstream-sync.ts",
        line: 64,
      },
    ],
    runtimeEvidence: [
      { kind: "tests-run", detail: "vitest 1284 passed, 0 failed" },
      { kind: "ci-green", detail: "checks green on 401 at a91c3f5" },
    ],
  },
  {
    jobId: "rev-106",
    repo: "nomior-dev/nomior-invest",
    pullRequestNumber: 379,
    pullRequestTitle: "feat(agents): unattended portfolio rebalancer",
    headSha: "6d2b840",
    riskTier: "high",
    status: "not-approved",
    pullRequestState: "open",
    verdict: "not-approved",
    manualReviewRequested: false,
    attempts: 2,
    createdAt: "2026-08-28T05:10:00.000Z",
    updatedAt: "2026-08-28T07:00:00.000Z",
    lastStartedAt: "2026-08-28T06:35:00.000Z",
    failureReason: null,
    findings: [
      {
        severity: "critical",
        summary:
          "Live orders are placed when dryRun is unset: the flag defaults to undefined, which is falsy, not to true.",
        file: "apps/server/src/agents/rebalancer.ts",
        line: 132,
      },
      {
        severity: "critical",
        summary:
          "Broker credentials are read from the environment and written into the retry log alongside the request payload.",
        file: "apps/server/src/agents/rebalancer.ts",
        line: 288,
      },
      {
        severity: "high",
        summary:
          "Position sizing divides by the previous close without guarding zero, so a halted symbol throws mid-batch and leaves the batch half-executed.",
        file: "apps/server/src/agents/sizing.ts",
        line: 57,
      },
      {
        severity: "high",
        summary:
          "Order submission carries no idempotency key: a retried batch doubles the position.",
        file: "apps/server/src/agents/orders.ts",
        line: 41,
      },
      {
        severity: "high",
        summary:
          "The kill switch is read once at start and never between legs of a multi-order rebalance.",
        file: "apps/server/src/agents/rebalancer.ts",
        line: 201,
      },
      {
        severity: "medium",
        summary:
          "The audit record is written after the orders, so a crash loses the trail for orders that did execute.",
        file: "apps/server/src/agents/audit.ts",
        line: 73,
      },
    ],
    runtimeEvidence: [
      { kind: "tests-run", detail: "vitest 812 passed, 3 failed in agents/rebalancer" },
    ],
  },
  // The last two are settled pull requests, and the board must not list them:
  // a review of merged or closed work is a card with nothing left to decide.
  {
    jobId: "rev-107",
    repo: "nomior-dev/nomior-code",
    pullRequestNumber: 396,
    pullRequestTitle: "fix(web): calendar header follows the grid",
    headSha: "c40f118",
    riskTier: "low",
    status: "approved",
    pullRequestState: "merged",
    verdict: "approve",
    manualReviewRequested: false,
    attempts: 1,
    createdAt: "2026-08-27T11:05:00.000Z",
    updatedAt: "2026-08-27T11:48:00.000Z",
    lastStartedAt: "2026-08-27T11:20:00.000Z",
    failureReason: null,
    findings: [],
    runtimeEvidence: [{ kind: "ci-green", detail: "checks green on 396 at c40f118" }],
  },
  {
    jobId: "rev-108",
    repo: "nomior-dev/nomior-music",
    pullRequestNumber: 91,
    pullRequestTitle: "spike(catalog): MusicBrainz as an ISRC backfill source",
    headSha: "0e7ab52",
    riskTier: "medium",
    status: "waiting-external",
    pullRequestState: "closed",
    verdict: null,
    manualReviewRequested: true,
    attempts: 1,
    createdAt: "2026-08-26T16:00:00.000Z",
    updatedAt: "2026-08-26T16:40:00.000Z",
    lastStartedAt: "2026-08-26T16:12:00.000Z",
    failureReason: null,
    findings: [
      {
        severity: "medium",
        summary:
          "The backfill reads MusicBrainz without a rate limit, which their terms cap at one request a second.",
        file: "apps/server/src/catalog/musicbrainz.ts",
        line: 44,
      },
    ],
    runtimeEvidence: [{ kind: "live-probe", detail: "300 lookups, 41 unmatched recordings" }],
  },
];

// ---------------------------------------------------------------------------
// Retrieval probes the simulator runs against the seeded corpus
// ---------------------------------------------------------------------------

export interface SeedContextProbe {
  readonly id: string;
  readonly question: string;
  readonly capsule: SeedCapsuleId;
  readonly budgetTokens: number;
  /** External ids at least one of which must appear in the cited answer. */
  readonly expectAnyOf: ReadonlyArray<string>;
}

/** Terms that exist in exactly one capsule; used for the scope-leak probes. */
export const SCOPE_LEAK_PROBES = [
  {
    id: "leak-personal-into-work",
    query: "EP master limiter vinyl ISRC",
    capsule: "nomior-code" as SeedCapsuleId,
    forbiddenCapsule: "home-studio" as SeedCapsuleId,
  },
  {
    id: "leak-work-into-personal",
    query: "verdict gate runtime evidence playbook",
    capsule: "home-studio" as SeedCapsuleId,
    forbiddenCapsule: "nomior-code" as SeedCapsuleId,
  },
] as const;

export const seedContextProbes: ReadonlyArray<SeedContextProbe> = [
  {
    id: "probe-gate-preconditions",
    question: "what does the review gate require before it approves a change",
    capsule: "nomior-code",
    budgetTokens: 700,
    expectAnyOf: ["meeting:meet-review-engine-0825", "notes:meet-review-engine-0825"],
  },
  {
    id: "probe-board-columns",
    question: "which columns does the review board show",
    capsule: "nomior-code",
    budgetTokens: 700,
    expectAnyOf: ["meeting:meet-standup-0824", "notes:meet-standup-0824"],
  },
  {
    id: "probe-anarlog-schema",
    question: "что делает коннектор при неизвестной схеме базы Anarlog",
    capsule: "nomior-code",
    budgetTokens: 700,
    expectAnyOf: ["meeting:meet-standup-0827", "notes:meet-standup-0827"],
  },
  {
    id: "probe-calendar-resync",
    question: "what happens when the calendar sync token expires with 410 GONE",
    capsule: "nomior-code",
    budgetTokens: 700,
    expectAnyOf: ["meeting:meet-anarlog-0826", "notes:meet-anarlog-0826"],
  },
  {
    id: "probe-master-loudness",
    question: "why is the EP master too loud and what do we ship instead",
    capsule: "home-studio",
    budgetTokens: 700,
    expectAnyOf: ["meeting:meet-ep-master-0828", "notes:meet-ep-master-0828"],
  },
  {
    // Deliberately tiny budget: proves the cap holds and the notice fires.
    id: "probe-tight-budget",
    question: "review engine retries backoff rate limited leg",
    capsule: "nomior-code",
    budgetTokens: 120,
    expectAnyOf: ["meeting:meet-review-engine-0825", "notes:meet-review-engine-0825"],
  },
];
