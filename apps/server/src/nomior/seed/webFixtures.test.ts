// @effect-diagnostics nodeBuiltinImport:off - reads the generated file off disk.
import * as NodeFS from "node:fs";

import { assert, describe, it } from "@effect/vitest";

import { seedGoogleAccounts, seedProviderInstances, seedReviewJobs } from "./scenario.ts";
import { renderWebFixturesModule, webFixtureData, webFixturesPath } from "./webFixtures.ts";

const data = webFixtureData();

describe("generated web fixtures", () => {
  it("matches the file the panels import", () => {
    assert.strictEqual(
      NodeFS.readFileSync(webFixturesPath(), "utf8"),
      renderWebFixturesModule(),
      "apps/web/src/nomior/fixtures.generated.ts is stale — run: pnpm --filter t3 nomior:gen-fixtures",
    );
  });

  it("renders the same text twice: the panels' data cannot drift on its own", () => {
    assert.strictEqual(renderWebFixturesModule(), renderWebFixturesModule());
  });

  it("carries every review job onto the board, one card per seeded job", () => {
    assert.strictEqual(data.reviewJobs.length, seedReviewJobs.length);
    assert.deepStrictEqual(
      data.reviewJobs.map((job) => job.id),
      seedReviewJobs.map((job) => job.jobId),
    );
    assert.deepStrictEqual(
      new Set(data.reviewJobs.map((job) => job.status)),
      new Set(["queue", "reviewing", "waiting-external", "approved", "not-approved"]),
    );
  });

  it("counts a critical finding as a blocker", () => {
    for (const job of seedReviewJobs) {
      const card = data.reviewJobs.find((entry) => entry.id === job.jobId);
      assert.isDefined(card);
      assert.strictEqual(
        card.severityCounts.blocker,
        job.findings.filter((finding) => finding.severity === "critical").length,
        `${job.jobId}: blocker count`,
      );
    }
  });

  it("shows both Google accounts and events that belong to them", () => {
    assert.deepStrictEqual(
      data.calendarAccounts.map((account) => account.id),
      seedGoogleAccounts.map((account) => account.accountId),
    );
    const accountIds = new Set(data.calendarAccounts.map((account) => account.id));
    for (const event of data.calendarEvents) {
      assert.isTrue(accountIds.has(event.accountId), `${event.id} has no account`);
      assert.isAtLeast(event.durationMinutes, 1);
      // Offsets are days from the scenario's Monday; the previous Friday's
      // review sits at -3, which the panel's range filter simply excludes.
      assert.isAtLeast(event.dayOffset, -7);
      assert.isBelow(event.dayOffset, 7);
      assert.isAtLeast(event.startHour, 0);
      assert.isBelow(event.startHour, 24);
    }
  });

  it("ranks snippets by descending score", () => {
    const scores = data.contextSnippets.map((snippet) => snippet.score);
    assert.isAtLeast(scores.length, 1);
    assert.deepStrictEqual(
      scores,
      [...scores].sort((left, right) => right - left),
    );
  });

  it("derives instance headroom from the seeded rate-limit usage", () => {
    assert.strictEqual(data.instances.length, seedProviderInstances.length);
    for (const instance of seedProviderInstances) {
      const card = data.instances.find((entry) => entry.id === instance.instanceId);
      assert.isDefined(card);
      if (card.health === "signed-out") {
        assert.isNull(card.headroom, `${instance.instanceId}: signed out has no headroom`);
      } else {
        assert.isAtLeast(card.headroom ?? -1, 0);
        assert.isAtMost(card.headroom ?? 2, 1);
      }
    }
  });

  it("explains the scheduler's last pick with an instance that exists", () => {
    const ids = new Set(data.instances.map((instance) => instance.id));
    assert.isTrue(ids.has(data.schedulerDecision.instanceId));
    assert.isNotEmpty(data.schedulerDecision.reason);
  });
});
