/**
 * Render smoke tests: every Nomior panel must produce markup standalone, with
 * nothing but the fixture port behind it. Effects do not run under static
 * rendering, so the panel-level tests exercise the pending/skeleton pass; the
 * data-bound JSX is covered by rendering each presentational subcomponent
 * directly against the fixture port's data.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { addDays, startOfWeek, toCalendarEvents } from "./calendar.logic";
import { AccountLegend, CalendarPanel } from "./CalendarPanel";
import {
  accountScope,
  ConnectorAccountRow,
  ConnectorList,
  ConnectorRow,
  ConnectorsPanel,
  GoogleProjectFooter,
  RemoteOAuthNotice,
  type ConnectorActionState,
} from "./ConnectorsPanel";
import { ContextMemoryPanel } from "./ContextMemoryPanel";
import { createFixtureNomiorPort } from "./fixtures";
import { GOOGLE_CLIENT_UNCONFIGURED } from "./fixtures.connectors";
import { InstanceRow, InstancesPanel } from "./InstancesPanel";
import {
  MeetingListRow,
  MeetingReader,
  MeetingsPanel,
  NotesReader,
  TranscriptReader,
} from "./MeetingsPanel";
import { PortErrorState } from "./PortErrorState";
import { ReviewBoardPanel, ReviewJobCard } from "./ReviewBoardPanel";
import { ReviewJobReader } from "./ReviewJobPanel";

describe("Nomior panels render standalone", () => {
  it("review board renders every column", () => {
    const markup = renderToStaticMarkup(<ReviewBoardPanel />);
    for (const title of ["Queue", "Reviewing", "Needs you", "Approved", "Not approved"]) {
      expect(markup).toContain(title);
    }
  });

  it("context & memory renders search, and nothing that asks for approval", () => {
    const markup = renderToStaticMarkup(<ContextMemoryPanel />);
    expect(markup).toContain("Search context");
    // Memories are written as they are produced; there is no queue to drain.
    expect(markup).not.toContain("Memory candidates");
  });

  it("calendar renders the date controls and every view it offers", () => {
    const markup = renderToStaticMarkup(<CalendarPanel />);
    expect(markup).toContain("Today");
    for (const label of ["Month", "Week", "Day", "Agenda", "By account"]) {
      expect(markup).toContain(label);
    }
  });

  it("instances renders the scheduler section", () => {
    const markup = renderToStaticMarkup(<InstancesPanel />);
    expect(markup).toContain("Scheduler");
    expect(markup).toContain("Advisory mode");
  });

  it("meetings renders both panes and the way back out of the detail", () => {
    const markup = renderToStaticMarkup(<MeetingsPanel />);
    expect(markup).toContain('aria-label="Meetings"');
    expect(markup).toContain("All meetings");
  });

  it("connectors labels its sample data before anything claims to be connected", () => {
    const markup = renderToStaticMarkup(<ConnectorsPanel />);
    expect(markup).toContain("Sample data");
  });
});

describe("Nomior panel subcomponents render fixture data", () => {
  // Fixed mid-week date so the fixture's relative timestamps are stable.
  const now = new Date(2026, 7, 26, 12, 0);
  const noop = () => undefined;

  it("review job cards carry the pull request, its project, and nothing else", async () => {
    const port = createFixtureNomiorPort(now);
    const jobs = await port.listReviewJobs();
    const markup = jobs.map((job) => renderToStaticMarkup(<ReviewJobCard job={job} />)).join("");
    expect(markup).toContain("feat(server): context broker retrieval pipeline");
    expect(markup).toContain("nomior-dev/nomior-code");
    expect(markup).toContain("#412");
    // The engine's judgement belongs to the job's page. A card that repeats it
    // is the board this one replaced.
    for (const absent of ["High risk", "blocker", "Not approved", "Request manual review"]) {
      expect(markup).not.toContain(absent);
    }
  });

  it("a review's own page carries the judgement the card leaves out", async () => {
    const port = createFixtureNomiorPort(now);
    const job = await port.getReviewJob("rev-106");
    const markup = renderToStaticMarkup(<ReviewJobReader job={job} onRequestManualReview={noop} />);
    expect(markup).toContain("feat(agents): unattended portfolio rebalancer");
    expect(markup).toContain("High risk");
    expect(markup).toContain("2 blocker");
    expect(markup).toContain("Not approved");
    expect(markup).toContain("https://github.com/nomior-dev/nomior-invest/pull/379");
  });

  it("a settled pull request says so on the page the board no longer links to", async () => {
    const port = createFixtureNomiorPort(now);
    const merged = await port.getReviewJob("rev-107");
    const markup = renderToStaticMarkup(
      <ReviewJobReader job={merged} onRequestManualReview={noop} />,
    );
    expect(markup).toContain("Merged");
  });

  it("the legend names every account and says which are filtered out", async () => {
    const port = createFixtureNomiorPort(now);
    const accounts = await port.listCalendarAccounts();
    expect(accounts.length).toBeGreaterThan(1);
    const hidden = new Set([accounts[0]!.id]);
    const markup = renderToStaticMarkup(
      <AccountLegend accounts={accounts} hiddenAccountIds={hidden} onToggleAccount={noop} />,
    );
    // A hidden account stays listed, or its filter has no way back.
    for (const account of accounts) {
      expect(markup).toContain(account.email);
    }
    expect(markup).toContain('aria-pressed="false"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it("maps fixture events onto the calendar with their account colours", async () => {
    const port = createFixtureNomiorPort(now);
    const weekStart = startOfWeek(now);
    const accounts = await port.listCalendarAccounts();
    const events = await port.listCalendarEvents(
      weekStart.toISOString(),
      addDays(weekStart, 7).toISOString(),
    );
    expect(events.length).toBeGreaterThan(0);
    const mapped = toCalendarEvents(events, accounts);
    expect(mapped.map((entry) => entry.title)).toContain("Daily standup");
    // Two accounts, two colours: the grid can tell them apart.
    expect(new Set(mapped.map((entry) => entry.color)).size).toBeGreaterThan(1);
  });

  it("instance rows show health, headroom, and disable pinning when signed out", async () => {
    const port = createFixtureNomiorPort(now);
    const instances = await port.listInstances();
    const markup = instances
      .map((instance) =>
        renderToStaticMarkup(<InstanceRow instance={instance} onTogglePin={noop} />),
      )
      .join("");
    expect(markup).toContain("Claude — main");
    expect(markup).toContain("72% headroom");
    expect(markup).toContain("Signed out");
    const signedOutMarkup = renderToStaticMarkup(
      <InstanceRow
        instance={instances.find((entry) => entry.health === "signed-out")!}
        onTogglePin={noop}
      />,
    );
    expect(signedOutMarkup).toContain("disabled");
  });

  it("meeting rows name a missing date and a missing length instead of faking them", async () => {
    const port = createFixtureNomiorPort(now);
    const meetings = await port.listMeetings!();
    const markup = meetings
      .map((meeting) =>
        renderToStaticMarkup(<MeetingListRow isActive={false} meeting={meeting} onSelect={noop} />),
      )
      .join("");
    expect(markup).toContain("Review engine deep dive");
    // The markdown fallback has neither a start time nor timing to derive from.
    expect(markup).toContain("Date unknown");
    expect(markup).toContain("Length unknown");
    expect(markup).toContain("No transcript");
  });

  it("the reader shows the header, the derived length and every participant", async () => {
    const port = createFixtureNomiorPort(now);
    const detail = await port.getMeeting!("meet-recorder-0826");
    const markup = renderToStaticMarkup(<MeetingReader detail={detail} />);
    expect(markup).toContain("Recorder pipeline");
    expect(markup).toContain("1 hr 3 min");
    expect(markup).toContain("On the calendar");
    expect(markup).toContain("Ivan Myshko");
    expect(markup).toContain("julius@t3.example");
  });

  it("groups consecutive turns from one speaker and names the unattributed ones", async () => {
    const port = createFixtureNomiorPort(now);
    const { transcript } = await port.getMeeting!("meet-recorder-0826");
    const markup = renderToStaticMarkup(<TranscriptReader turns={transcript} />);
    expect(markup).toContain("Unattributed");
    expect(markup).toContain("1:00:12");
    // Four turns came back unattributed, two of them back to back. They stay
    // four blocks: merging them would claim one person said both.
    expect(markup.split("Unattributed").length - 1).toBe(4);
  });

  it("an untimed transcript says so and shows no offsets at all", async () => {
    const port = createFixtureNomiorPort(now);
    const { transcript } = await port.getMeeting!("meet-friday-0821");
    const markup = renderToStaticMarkup(<TranscriptReader turns={transcript} />);
    expect(markup).toContain("arrived without timing");
    expect(markup).not.toContain("00:00");
  });

  it("an empty transcript and absent notes are stated, not left blank", async () => {
    const port = createFixtureNomiorPort(now);
    const empty = await port.getMeeting!("meet-ep-master-0828");
    expect(empty.transcript).toHaveLength(0);
    const emptyMarkup = renderToStaticMarkup(<TranscriptReader turns={empty.transcript} />);
    expect(emptyMarkup).toContain("No transcript");
    expect(emptyMarkup).toContain("found no speech");

    const standup = await port.getMeeting!("meet-standup-0827");
    expect(standup.notes).toBeNull();
    const notesMarkup = renderToStaticMarkup(<NotesReader notes={standup.notes} />);
    expect(notesMarkup).toContain("No notes");
  });

  it("notes render as a document rather than raw markdown", async () => {
    const port = createFixtureNomiorPort(now);
    const { notes } = await port.getMeeting!("meet-review-engine-0825");
    const markup = renderToStaticMarkup(<NotesReader notes={notes} />);
    expect(markup).toContain("<h3");
    expect(markup).toContain("<ul");
    expect(markup).toContain("<ol");
    expect(markup).toContain("<strong");
    expect(markup).not.toContain("## Decisions");
  });

  const idle: ConnectorActionState = { pendingScope: null, notice: null };

  /**
   * The rendered attribute, not the word: every button carries `disabled:`
   * variant classes, so matching the bare word passes on a live control.
   */
  const DISABLED_ATTRIBUTE = 'disabled=""';

  it("every connector is one row, with its accounts under it", async () => {
    const port = createFixtureNomiorPort(now);
    const overview = await port.listConnectors();
    const markup = renderToStaticMarkup(
      <ConnectorList
        onConnect={noop}
        onDisconnect={noop}
        onSync={noop}
        overview={overview}
        state={idle}
      />,
    );
    for (const label of ["Connector", "Status"]) expect(markup).toContain(label);
    expect(markup).toContain("Google Calendar");
    expect(markup).toContain("work@nomior.example");
    // A connector with accounts adds, it does not connect again.
    expect(markup).toContain("Add account");
    // Three statuses, three sentences: one retryable, one terminal, one blank.
    expect(markup).toContain("Sync again");
    expect(markup).toContain("Retrying will not help");
    expect(markup).toContain("Never synced");
    // The redacted detail is the only place a failure explains itself.
    expect(markup).toContain("daily quota is spent");
  });

  it("an unconnected connector says what connecting it would buy", async () => {
    const port = createFixtureNomiorPort(now);
    const overview = await port.listConnectors();
    const markup = renderToStaticMarkup(
      <ConnectorRow
        kind="gmail"
        onConnect={noop}
        overview={{ ...overview, accounts: [] }}
        state={idle}
      />,
    );
    expect(markup).toContain("Gmail");
    expect(markup).toContain("cited as context");
    expect(markup).toContain(">Connect<");
  });

  it("disconnect asks before it fires, and a pending action locks its own row", async () => {
    const port = createFixtureNomiorPort(now);
    const account = (await port.listConnectors()).accounts[0]!;
    const resting = renderToStaticMarkup(
      <ConnectorAccountRow account={account} onDisconnect={noop} onSync={noop} state={idle} />,
    );
    expect(resting).toContain("Disconnect");
    // The confirmation is not pre-armed: the first click only asks.
    expect(resting).not.toContain("drops its stored token");

    const pending = renderToStaticMarkup(
      <ConnectorAccountRow
        account={account}
        onDisconnect={noop}
        onSync={noop}
        state={{ pendingScope: accountScope(account.id), notice: null }}
      />,
    );
    expect(pending).toContain(DISABLED_ATTRIBUTE);
  });

  it("an action failure lands next to the control that fired it", async () => {
    const port = createFixtureNomiorPort(now);
    const account = (await port.listConnectors()).accounts[0]!;
    const markup = renderToStaticMarkup(
      <ConnectorAccountRow
        account={account}
        onDisconnect={noop}
        onSync={noop}
        state={{
          pendingScope: null,
          notice: { scope: accountScope(account.id), tone: "error", text: "Google said no." },
        }}
      />,
    );
    expect(markup).toContain("Google said no.");
    expect(markup).toContain('role="status"');
  });

  it("a disconnect result outlives the row it removed", async () => {
    const port = createFixtureNomiorPort(now);
    const overview = await port.listConnectors();
    const [removed, ...remaining] = overview.accounts;
    const markup = renderToStaticMarkup(
      <ConnectorList
        onConnect={noop}
        onDisconnect={noop}
        onSync={noop}
        overview={{ ...overview, accounts: remaining }}
        state={{
          pendingScope: null,
          notice: { scope: accountScope(removed!.id), tone: "success", text: "Disconnected." },
        }}
      />,
    );
    expect(markup).toContain("Disconnected.");
  });

  it("a build that carries its own client id shows no field at all", async () => {
    const port = createFixtureNomiorPort(now);
    const overview = await port.listConnectors();
    const row = renderToStaticMarkup(
      <ConnectorRow kind="googleCalendar" onConnect={noop} overview={overview} state={idle} />,
    );
    expect(row).not.toContain(DISABLED_ATTRIBUTE);
    expect(row).not.toContain("client id");
    // The whole subject is one closed line at the foot of the page.
    const footer = renderToStaticMarkup(
      <GoogleProjectFooter onSave={noop} overview={overview} state={idle} />,
    );
    expect(footer).toContain("Use your own Google project");
    expect(footer).not.toContain("<input");
  });

  it("with no client id the row goes quiet and the footer says why", async () => {
    const port = createFixtureNomiorPort(now);
    const overview = await port.listConnectors();
    const unconfigured = { ...overview, google: GOOGLE_CLIENT_UNCONFIGURED };
    const footer = renderToStaticMarkup(
      <GoogleProjectFooter onSave={noop} overview={unconfigured} state={idle} />,
    );
    expect(footer).toContain("ships no Google client id");
    expect(footer).toContain("Add one");

    // The row is off, and points at that line rather than repeating it.
    const row = renderToStaticMarkup(
      <ConnectorRow kind="googleCalendar" onConnect={noop} overview={unconfigured} state={idle} />,
    );
    expect(row).toContain(DISABLED_ATTRIBUTE);
    expect(row).toContain('aria-describedby="nomior-google-client-id"');
    expect(row).not.toContain("client id.");
  });

  it("a remote client is told the redirect cannot land here, ahead of any fixable reason", async () => {
    const port = createFixtureNomiorPort(now);
    const overview = await port.listConnectors();
    const remote = { ...overview, canStartLocalOAuth: false, google: GOOGLE_CLIENT_UNCONFIGURED };
    expect(renderToStaticMarkup(<RemoteOAuthNotice />)).toContain("loopback address");
    const row = renderToStaticMarkup(
      <ConnectorRow kind="googleCalendar" onConnect={noop} overview={remote} state={idle} />,
    );
    expect(row).toContain(DISABLED_ATTRIBUTE);
    // The client id is missing too, but pointing at it would imply that
    // pasting one is enough to finish a sign-in this browser cannot finish.
    expect(row).toContain('aria-describedby="nomior-remote-oauth"');
  });

  it("port error state names the failure and offers a retry", () => {
    const markup = renderToStaticMarkup(
      <PortErrorState label="Couldn't load review jobs." onRetry={noop} />,
    );
    expect(markup).toContain("Couldn&#x27;t load review jobs.");
    expect(markup).toContain("Retry");
  });
});
