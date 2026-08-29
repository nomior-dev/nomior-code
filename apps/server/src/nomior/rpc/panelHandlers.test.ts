/**
 * The panel handlers against a really-seeded database.
 *
 * Service fakes cannot catch the failure this file exists for: a handler that
 * queries by a value the writer never writes returns an empty list, and a fake
 * built from the handler's own spelling agrees with it. Only the real seed and
 * the real stores disagree, so this reads what the seeder wrote.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as ConnectorAccountStore from "../connectors/ConnectorAccountStore.ts";
import * as CalendarEventStore from "../connectors/calendar/CalendarEventStore.ts";
import * as ReviewJobStore from "../review/ReviewJobStore.ts";
import { DeterministicSeedRuntime } from "../seed/deterministic.ts";
import { SEED_NOW, seedCalendarEvents, seedConnectorAccounts } from "../seed/scenario.ts";
import { NomiorSeedServices, seedNomior } from "../seed/seed.ts";
import { listCalendarAccounts, listCalendarEvents, listReviewJobs } from "./panelHandlers.ts";

const seedRuntime = NomiorSeedServices.pipe(
  Layer.provideMerge(
    DeterministicSeedRuntime(SEED_NOW).pipe(Layer.provideMerge(NodeServices.layer)),
  ),
);

const runSeed = seedNomior().pipe(Effect.provide(seedRuntime));

const layer = it.layer(
  Layer.mergeAll(ConnectorAccountStore.layer, CalendarEventStore.layer, ReviewJobStore.layer).pipe(
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provide(NodeServices.layer),
  ),
);

/** Wide enough to hold every seeded event, whatever week the scenario sits in. */
const WHOLE_SCENARIO = {
  rangeStart: "2000-01-01T00:00:00.000Z",
  rangeEnd: "2100-01-01T00:00:00.000Z",
};

describe("panel handlers over the seeded database", () => {
  layer((it) => {
    it.effect("lists every calendar account the seeder connected", () =>
      Effect.gen(function* () {
        yield* runSeed;
        const { accounts } = yield* listCalendarAccounts(
          yield* ConnectorAccountStore.ConnectorAccountStore,
        );

        const expected = seedConnectorAccounts.filter(
          (account) => account.driverKind === "googleCalendar",
        );
        assert.strictEqual(accounts.length, expected.length);
        assert.isAbove(accounts.length, 0);
        assert.deepStrictEqual(
          accounts.map((account) => account.email).toSorted(),
          expected.map((account) => account.displayName).toSorted(),
        );
        // Colour index is the row's position, so it must be dense from zero.
        assert.deepStrictEqual(
          accounts.map((account) => account.colorIndex),
          accounts.map((_, index) => index),
        );
      }),
    );

    it.effect("returns every seeded event, each owned by a listed account", () =>
      Effect.gen(function* () {
        yield* runSeed;
        const { events } = yield* listCalendarEvents(
          yield* CalendarEventStore.CalendarEventStore,
          WHOLE_SCENARIO,
        );
        const { accounts } = yield* listCalendarAccounts(
          yield* ConnectorAccountStore.ConnectorAccountStore,
        );

        assert.strictEqual(events.length, seedCalendarEvents.length);
        const listed = new Set(accounts.map((account) => account.id));
        for (const event of events) {
          assert.isTrue(
            listed.has(event.accountId),
            `event ${event.id} belongs to ${event.accountId}, which the accounts list omits`,
          );
        }
      }),
    );

    it.effect("fills the review board with cards that carry a title", () =>
      Effect.gen(function* () {
        yield* runSeed;
        const { jobs } = yield* listReviewJobs(yield* ReviewJobStore.ReviewJobStore);

        assert.isAbove(jobs.length, 0);
        for (const job of jobs) {
          assert.isAbove(job.pullRequestTitle.length, 0, `job ${job.id} has no title`);
          assert.isAbove(job.pullRequestNumber, 0);
        }
      }),
    );
  });
});
