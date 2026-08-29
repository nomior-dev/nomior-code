import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { ConnectorSelectorRequiredError } from "../Errors.ts";
import { ConnectorAccountId } from "../Records.ts";
import { GmailDriver } from "./GmailDriver.ts";
import {
  GmailPort,
  type GmailMessage,
  GoogleApiError,
  GoogleTokenPort,
  type GoogleTokenSet,
} from "./GooglePorts.ts";
import { GoogleTokenVault } from "./GoogleTokenVault.ts";

const accountId = ConnectorAccountId.make("gmail_work");

const decodeConfig = Schema.decodeUnknownSync(GmailDriver.configSchema);

const tokenSet: GoogleTokenSet = {
  accessToken: "access",
  refreshToken: "refresh",
  scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
};

const vaultLayer = Layer.succeed(
  GoogleTokenVault,
  GoogleTokenVault.of({
    get: () => Effect.succeed(Option.some(tokenSet)),
    set: () => Effect.void,
    remove: () => Effect.void,
  }),
);

const tokenPortLayer = Layer.succeed(
  GoogleTokenPort,
  GoogleTokenPort.of({
    exchangeAuthorizationCode: () => Effect.succeed(tokenSet),
    refreshAccessToken: () => Effect.succeed(tokenSet),
    revokeToken: () => Effect.void,
  }),
);

// Like the real API: messages carry label IDS ("Label_7"), while search and
// the user speak label NAMES ("team-updates"). The driver must bridge them.
const messages: Record<string, GmailMessage> = {
  m1: {
    id: "m1",
    threadId: "t1",
    labelIds: ["INBOX"],
    internalDate: "1787565600000",
    subject: "Weekly Planning agenda",
    from: "Sam <sam@example.com>",
    to: "ivan@example.com",
    snippet: "Agenda attached.",
  },
  m2: {
    id: "m2",
    threadId: "t2",
    labelIds: ["INBOX"],
    internalDate: "1787565700000",
    subject: "Unrelated newsletter",
    from: "news@stuff.example",
    to: "ivan@example.com",
    snippet: "This week in stuff.",
  },
  m3: {
    id: "m3",
    threadId: "t3",
    labelIds: ["Label_7"],
    internalDate: "1787565800000",
    subject: "Deploy report",
    from: "bot@example.com",
    snippet: "All green.",
  },
};

interface GmailFakeState {
  historyFailsWith404: boolean;
  readonly historyRefs: Array<string>;
  readonly labelsAddedRefs: Array<string>;
  /** listMessages pages of message ids; empty = derive one page per query. */
  readonly searchPages: Array<Array<string>>;
  readonly seenQueries: Array<string>;
}

const gmailPortLayer = (state: GmailFakeState): Layer.Layer<GmailPort> =>
  Layer.succeed(
    GmailPort,
    GmailPort.of({
      getProfile: () => Effect.succeed({ emailAddress: "ivan@example.com", historyId: "100" }),
      listLabels: () =>
        Effect.succeed([
          { id: "INBOX", name: "INBOX" },
          { id: "Label_7", name: "team-updates" },
        ]),
      listHistory: ({ startHistoryId }) =>
        state.historyFailsWith404
          ? Effect.fail(new GoogleApiError({ status: 404, operation: "gmail.history.list" }))
          : Effect.succeed({
              messagesAdded: state.historyRefs.flatMap((id) => {
                const message = messages[id];
                return message === undefined ? [] : [{ id, threadId: message.threadId }];
              }),
              labelsAdded: state.labelsAddedRefs.flatMap((id) => {
                const message = messages[id];
                return message === undefined ? [] : [{ id, threadId: message.threadId }];
              }),
              historyId: `${Number(startHistoryId) + 50}`,
            }),
      listMessages: ({ query, pageToken }) => {
        state.seenQueries.push(query);
        if (state.searchPages.length > 0) {
          const index = pageToken === undefined ? 0 : Number(pageToken);
          const page = state.searchPages[index] ?? [];
          const next = index + 1 < state.searchPages.length ? `${index + 1}` : undefined;
          return Effect.succeed({
            messages: page.flatMap((id) => {
              const message = messages[id];
              return message === undefined ? [] : [{ id, threadId: message.threadId }];
            }),
            ...(next === undefined ? {} : { nextPageToken: next }),
          });
        }
        return Effect.succeed({
          // The fake honors the selector-scoped query loosely: sender query
          // returns m1+m2, label query (by NAME) returns m3.
          messages: [
            ...(query.includes("from:sam@example.com") ? [{ id: "m1", threadId: "t1" }] : []),
            ...(query.includes("from:sam@example.com") ? [{ id: "m2", threadId: "t2" }] : []),
            ...(query.includes("label:team-updates") ? [{ id: "m3", threadId: "t3" }] : []),
          ],
        });
      },
      getMessage: ({ id }) => {
        const message = messages[id];
        return message === undefined
          ? Effect.fail(new GoogleApiError({ status: 404, operation: "gmail.messages.get" }))
          : Effect.succeed(message);
      },
    }),
  );

const makeInstance = (config: unknown) =>
  GmailDriver.create({ accountId, displayName: undefined, config: decodeConfig(config) });

const provideAll = <A, E>(
  state: GmailFakeState,
  effect: Effect.Effect<A, E, GmailPort | GoogleTokenVault | GoogleTokenPort>,
) => effect.pipe(Effect.provide(Layer.mergeAll(gmailPortLayer(state), vaultLayer, tokenPortLayer)));

const freshState = (): GmailFakeState => ({
  historyFailsWith404: false,
  historyRefs: [],
  labelsAddedRefs: [],
  searchPages: [],
  seenQueries: [],
});

it.effect("refuses to sync without an explicit selector", () =>
  provideAll(
    freshState(),
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* makeInstance({});
        const health = yield* instance.health;
        assert.strictEqual(health._tag, "needs-selection");
        const failure = yield* instance.sync({ cursor: null }).pipe(Effect.flip);
        assert.instanceOf(failure, ConnectorSelectorRequiredError);
      }),
    ),
  ),
);

it.effect("bootstraps from selectors, filters to them, and stores the baseline historyId", () =>
  provideAll(
    freshState(),
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* makeInstance({ senders: ["sam@example.com"] });
        assert.deepEqual(yield* instance.health, { _tag: "ok" });

        const result = yield* instance.sync({ cursor: null });
        assert.isFalse(result.cursorInvalidated);
        assert.isUndefined(result.hasMore);
        assert.strictEqual(result.nextCursor, '{"historyId":"100"}');
        // m2 came back from the search but does not match the sender
        // selector, so it is filtered out — opt-in stays strict.
        assert.deepEqual(
          result.records.map((record) => record.source.sourceId),
          ["message:m1"],
        );
        const mail = result.records[0];
        assert.strictEqual(mail?.source.kind, "mail_message");
        assert.strictEqual(mail?.source.links.mailThreadId, "t1");
        assert.strictEqual(mail?.source.title, "Weekly Planning agenda");
        assert.deepEqual(mail?.source.participants, [
          { name: "Sam", email: "sam@example.com" },
          { email: "ivan@example.com" },
        ]);
        assert.deepEqual(
          mail?.chunks.map((chunk) => chunk.text),
          ["Weekly Planning agenda\nAgenda attached."],
        );
      }),
    ),
  ),
);

it.effect("sender selectors match whole addresses and domains, never substrings", () =>
  Effect.gen(function* () {
    const state = freshState();
    state.historyRefs.push("m1", "m2");
    yield* provideAll(
      state,
      Effect.scoped(
        Effect.gen(function* () {
          // "an@example.com" must NOT substring-match "ivan@example.com"
          // (m1's To is irrelevant; its From is sam@example.com).
          const substringInstance = yield* makeInstance({ senders: ["am@example.com"] });
          const substringResult = yield* substringInstance.sync({
            cursor: '{"historyId":"100"}',
          });
          assert.deepEqual(substringResult.records, []);

          // A domain selector matches every address at that domain.
          const domainInstance = yield* makeInstance({ senders: ["stuff.example"] });
          const domainResult = yield* domainInstance.sync({ cursor: '{"historyId":"100"}' });
          assert.deepEqual(
            domainResult.records.map((record) => record.source.sourceId),
            ["message:m2"],
          );
        }),
      ),
    );
  }),
);

it.effect("resolves label names to ids for the incremental filter", () =>
  Effect.gen(function* () {
    const state = freshState();
    state.historyRefs.push("m3", "m1");
    yield* provideAll(
      state,
      Effect.scoped(
        Effect.gen(function* () {
          // The user selected the label NAME; m3 carries only the label ID.
          const instance = yield* makeInstance({ labels: ["team-updates"] });
          const result = yield* instance.sync({ cursor: '{"historyId":"100"}' });
          assert.isFalse(result.cursorInvalidated);
          assert.strictEqual(result.nextCursor, '{"historyId":"150"}');
          assert.deepEqual(
            result.records.map((record) => record.source.sourceId),
            ["message:m3"],
          );
        }),
      ),
    );
  }),
);

it.effect("accepts a label id selector and uses the name in the bootstrap query", () =>
  Effect.gen(function* () {
    const state = freshState();
    yield* provideAll(
      state,
      Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* makeInstance({ labels: ["Label_7"] });
          const result = yield* instance.sync({ cursor: null });
          // The search went out with the label NAME, not the raw id.
          assert.deepEqual(state.seenQueries, ["label:team-updates"]);
          assert.deepEqual(
            result.records.map((record) => record.source.sourceId),
            ["message:m3"],
          );
        }),
      ),
    );
  }),
);

it.effect("ingests an existing message that just gained a selected label", () =>
  Effect.gen(function* () {
    const state = freshState();
    state.labelsAddedRefs.push("m3");
    yield* provideAll(
      state,
      Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* makeInstance({ labels: ["team-updates"] });
          const result = yield* instance.sync({ cursor: '{"historyId":"100"}' });
          assert.deepEqual(
            result.records.map((record) => record.source.sourceId),
            ["message:m3"],
          );
        }),
      ),
    );
  }),
);

it.effect("re-bootstraps when the historyId has expired (404) and flags invalidation", () =>
  Effect.gen(function* () {
    const state = freshState();
    state.historyFailsWith404 = true;
    yield* provideAll(
      state,
      Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* makeInstance({ labels: ["team-updates"] });
          const result = yield* instance.sync({ cursor: '{"historyId":"1"}' });
          assert.isTrue(result.cursorInvalidated);
          // Fresh baseline from the profile, not the dead cursor.
          assert.strictEqual(result.nextCursor, '{"historyId":"100"}');
          assert.deepEqual(
            result.records.map((record) => record.source.sourceId),
            ["message:m3"],
          );
        }),
      ),
    );
  }),
);

it.effect("thread selector matches by thread id during incremental sync", () =>
  Effect.gen(function* () {
    const state = freshState();
    state.historyRefs.push("m1", "m2");
    yield* provideAll(
      state,
      Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* makeInstance({ threadIds: ["t2"] });
          const result = yield* instance.sync({ cursor: '{"historyId":"100"}' });
          assert.deepEqual(
            result.records.map((record) => record.source.sourceId),
            ["message:m2"],
          );
        }),
      ),
    );
  }),
);

it.effect("signals hasMore at the bootstrap page cap and resumes to completion", () =>
  Effect.gen(function* () {
    const state = freshState();
    // More search pages than MAX_PAGES_PER_SYNC (50): the first sync must
    // stop at the cap WITHOUT advancing past the baseline, then resume.
    for (let index = 0; index < 60; index += 1) {
      state.searchPages.push([index % 2 === 0 ? "m1" : "m2"]);
    }
    yield* provideAll(
      state,
      Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* makeInstance({ senders: ["sam@example.com"] });

          const first = yield* instance.sync({ cursor: null });
          assert.isTrue(first.hasMore);
          assert.strictEqual(first.nextCursor, '{"historyId":"100","bootstrapPageToken":"50"}');
          assert.deepEqual(
            first.records.map((record) => record.source.sourceId),
            ["message:m1"],
          );

          // Resuming drains the remaining pages and lands on the SAME
          // baseline historyId captured before the walk started.
          const second = yield* instance.sync({ cursor: first.nextCursor });
          assert.isUndefined(second.hasMore);
          assert.strictEqual(second.nextCursor, '{"historyId":"100"}');
        }),
      ),
    );
  }),
);
