/**
 * Render smoke tests: every Nomior panel must produce markup standalone, with
 * nothing but the fixture port behind it. Effects do not run under static
 * rendering, so the panel-level tests exercise the pending/skeleton pass; the
 * data-bound JSX is covered by rendering each presentational subcomponent
 * directly against the fixture port's data.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { addDays, startOfWeek } from "./calendar.logic";
import { AgendaList, CalendarPanel, WeekGrid } from "./CalendarPanel";
import {
  accountScope,
  AdvancedConnectorSection,
  AnarlogConnectorSection,
  ConnectorAccountList,
  ConnectorAccountRow,
  ConnectorsPanel,
  GoogleConnectorSection,
  RemoteOAuthNotice,
  type ConnectorActionState,
} from "./ConnectorsPanel";
import { ContextMemoryPanel, MemoryCandidateRow } from "./ContextMemoryPanel";
import { createFixtureNomiorPort } from "./fixtures";
import {
  ANARLOG_NOT_FOUND,
  ANARLOG_UNSUPPORTED_SCHEMA,
  GOOGLE_CLIENT_UNCONFIGURED,
} from "./fixtures.connectors";
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

describe("Nomior panels render standalone", () => {
  it("review board renders every column", () => {
    const markup = renderToStaticMarkup(<ReviewBoardPanel />);
    for (const title of ["Queue", "Reviewing", "Waiting external", "Approved", "Not approved"]) {
      expect(markup).toContain(title);
    }
  });

  it("context & memory renders search and the approval queue", () => {
    const markup = renderToStaticMarkup(<ContextMemoryPanel />);
    expect(markup).toContain("Search context");
    expect(markup).toContain("Memory candidates");
  });

  it("calendar renders the week controls and view toggle", () => {
    const markup = renderToStaticMarkup(<CalendarPanel />);
    expect(markup).toContain("Today");
    expect(markup).toContain("Agenda");
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
    expect(markup).toContain("Where Nomior");
  });
});

describe("Nomior panel subcomponents render fixture data", () => {
  // Fixed mid-week date so the fixture's relative timestamps are stable.
  const now = new Date(2026, 7, 26, 12, 0);
  const noop = () => undefined;

  it("review job cards show repo, PR, severity chips and the manual-review action", async () => {
    const port = createFixtureNomiorPort(now);
    const jobs = await port.listReviewJobs();
    const markup = jobs
      .map((job) => renderToStaticMarkup(<ReviewJobCard job={job} onRequestManualReview={noop} />))
      .join("");
    expect(markup).toContain("nomior-dev/nomior-code");
    expect(markup).toContain("#412");
    expect(markup).toContain("2 blocker");
    expect(markup).toContain("Not approved");
    expect(markup).toContain("Request manual review");
  });

  it("week grid places fixture events with account colors", async () => {
    const port = createFixtureNomiorPort(now);
    const weekStart = startOfWeek(now);
    const accounts = await port.listCalendarAccounts();
    const events = await port.listCalendarEvents(
      weekStart.toISOString(),
      addDays(weekStart, 7).toISOString(),
    );
    expect(events.length).toBeGreaterThan(0);
    const markup = renderToStaticMarkup(
      <WeekGrid accounts={accounts} events={events} today={now} weekStart={weekStart} />,
    );
    expect(markup).toContain("Daily standup");
    expect(markup).toContain("Review engine deep dive");
  });

  it("agenda lists fixture events with account emails and artifact badges", async () => {
    const port = createFixtureNomiorPort(now);
    const weekStart = startOfWeek(now);
    const accounts = await port.listCalendarAccounts();
    const events = await port.listCalendarEvents(
      weekStart.toISOString(),
      addDays(weekStart, 7).toISOString(),
    );
    const markup = renderToStaticMarkup(
      <AgendaList accounts={accounts} events={events} weekStart={weekStart} />,
    );
    expect(markup).toContain("Dentist");
    expect(markup).toContain("personal@gmail.example");
    expect(markup).toContain("Transcript");
  });

  it("memory candidate rows offer decisions while pending and show the verdict after", async () => {
    const port = createFixtureNomiorPort(now);
    const pending = (await port.listMemoryCandidates())[0]!;
    const pendingMarkup = renderToStaticMarkup(
      <MemoryCandidateRow candidate={pending} onResolve={noop} />,
    );
    expect(pendingMarkup).toContain("Approve");
    expect(pendingMarkup).toContain("Reject");

    await port.resolveMemoryCandidate(pending.id, "approved");
    const resolved = (await port.listMemoryCandidates()).find(
      (candidate) => candidate.id === pending.id,
    )!;
    const resolvedMarkup = renderToStaticMarkup(
      <MemoryCandidateRow candidate={resolved} onResolve={noop} />,
    );
    expect(resolvedMarkup).toContain("Approved");
    expect(resolvedMarkup).not.toContain("Reject");
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
    const detail = await port.getMeeting!("meet-anarlog-0826");
    const markup = renderToStaticMarkup(<MeetingReader detail={detail} />);
    expect(markup).toContain("Anarlog connector integration");
    expect(markup).toContain("1 hr 3 min");
    expect(markup).toContain("On the calendar");
    expect(markup).toContain("Ivan Myshko");
    expect(markup).toContain("julius@t3.example");
  });

  it("groups consecutive turns from one speaker and names the unattributed ones", async () => {
    const port = createFixtureNomiorPort(now);
    const { transcript } = await port.getMeeting!("meet-anarlog-0826");
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

  it("account rows keep never-synced, retryable and revoked apart", async () => {
    const port = createFixtureNomiorPort(now);
    const overview = await port.listConnectors();
    const markup = renderToStaticMarkup(
      <ConnectorAccountList onDisconnect={noop} onSync={noop} overview={overview} state={idle} />,
    );
    expect(markup).toContain("work@nomior.example");
    expect(markup).toContain("Google Calendar");
    // Three statuses, three sentences: one retryable, one terminal, one blank.
    expect(markup).toContain("Sync failed");
    expect(markup).toContain("Access revoked");
    expect(markup).toContain("Never synced");
    expect(markup).toContain("Sync again");
    expect(markup).toContain("Retrying will not help");
    // The redacted detail is the only place a failure explains itself.
    expect(markup).toContain("daily quota is spent");
  });

  it("no accounts says what connecting one would get you", async () => {
    const port = createFixtureNomiorPort(now);
    const overview = await port.listConnectors();
    const markup = renderToStaticMarkup(
      <ConnectorAccountList
        onDisconnect={noop}
        onSync={noop}
        overview={{ ...overview, accounts: [] }}
        state={idle}
      />,
    );
    expect(markup).toContain("No accounts connected");
    expect(markup).toContain("sample data");
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
      <ConnectorAccountList
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

  it("a build that carries its own client id asks for nothing: one live button", async () => {
    const port = createFixtureNomiorPort(now);
    const overview = await port.listConnectors();
    const google = renderToStaticMarkup(
      <GoogleConnectorSection onConnect={noop} overview={overview} state={idle} />,
    );
    expect(google).toContain("Connect Google account");
    expect(google).not.toContain(DISABLED_ATTRIBUTE);
    // Setup moved to Advanced, and Advanced is closed: no field on screen.
    expect(google).not.toContain("client id");
    const advanced = renderToStaticMarkup(
      <AdvancedConnectorSection
        onConnect={noop}
        onSaveClientId={noop}
        overview={overview}
        state={idle}
      />,
    );
    expect(advanced).toContain("Advanced");
    expect(advanced).not.toContain("OAuth client id");
  });

  it("with no client id anywhere, the button says where the setup step is", async () => {
    const port = createFixtureNomiorPort(now);
    const overview = await port.listConnectors();
    const unconfigured = { ...overview, google: GOOGLE_CLIENT_UNCONFIGURED };
    const google = renderToStaticMarkup(
      <GoogleConnectorSection onConnect={noop} overview={unconfigured} state={idle} />,
    );
    expect(google).toContain("Advanced");
    // Connect is off, but it says why rather than sitting there dead.
    expect(google).toContain(DISABLED_ATTRIBUTE);

    // And Advanced opens on its own, because this is the one build where the
    // page can do nothing at all until someone fills that field in.
    const advanced = renderToStaticMarkup(
      <AdvancedConnectorSection
        onConnect={noop}
        onSaveClientId={noop}
        overview={unconfigured}
        state={idle}
      />,
    );
    expect(advanced).toContain("OAuth client id");
    expect(advanced).toContain("No client id yet");
    // Gmail lives here rather than in the default path: its scope is restricted.
    expect(advanced).toContain("Gmail");
  });

  it("a remote client is told the redirect cannot land here, ahead of any fixable reason", async () => {
    const port = createFixtureNomiorPort(now);
    const overview = await port.listConnectors();
    const remote = { ...overview, canStartLocalOAuth: false, google: GOOGLE_CLIENT_UNCONFIGURED };
    expect(renderToStaticMarkup(<RemoteOAuthNotice />)).toContain("loopback address");
    const markup = renderToStaticMarkup(
      <GoogleConnectorSection onConnect={noop} overview={remote} state={idle} />,
    );
    expect(markup).toContain("loopback address");
    expect(markup).toContain(DISABLED_ATTRIBUTE);
    // The client id is still missing, but saying so here would imply that
    // pasting one is enough to finish a sign-in this browser cannot finish.
    expect(markup).not.toContain("Advanced");
  });

  it("anarlog reads as found, absent or refused, never as one merged state", async () => {
    const port = createFixtureNomiorPort(now);
    const overview = await port.listConnectors();
    const withoutAccounts = { ...overview, accounts: [] };
    const found = renderToStaticMarkup(
      <AnarlogConnectorSection onConnect={noop} overview={withoutAccounts} state={idle} />,
    );
    const missing = renderToStaticMarkup(
      <AnarlogConnectorSection
        onConnect={noop}
        overview={{ ...withoutAccounts, anarlog: ANARLOG_NOT_FOUND }}
        state={idle}
      />,
    );
    const refused = renderToStaticMarkup(
      <AnarlogConnectorSection
        onConnect={noop}
        overview={{ ...withoutAccounts, anarlog: ANARLOG_UNSUPPORTED_SCHEMA }}
        state={idle}
      />,
    );
    expect(found).toContain("Store found");
    expect(found).toContain("anarlog.sqlite");
    expect(missing).toContain("No store");
    expect(missing).toContain("no store there");
    // Found and refused names the version, so nobody reads it as absent.
    expect(refused).toContain("Schema too new");
    expect(refused).toContain("v9");
  });

  it("port error state names the failure and offers a retry", () => {
    const markup = renderToStaticMarkup(
      <PortErrorState label="Couldn't load review jobs." onRetry={noop} />,
    );
    expect(markup).toContain("Couldn&#x27;t load review jobs.");
    expect(markup).toContain("Retry");
  });
});
