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
import { ContextMemoryPanel, MemoryCandidateRow } from "./ContextMemoryPanel";
import { createFixtureNomiorPort } from "./fixtures";
import { InstanceRow, InstancesPanel } from "./InstancesPanel";
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

  it("port error state names the failure and offers a retry", () => {
    const markup = renderToStaticMarkup(
      <PortErrorState label="Couldn't load review jobs." onRetry={noop} />,
    );
    expect(markup).toContain("Couldn&#x27;t load review jobs.");
    expect(markup).toContain("Retry");
  });
});
