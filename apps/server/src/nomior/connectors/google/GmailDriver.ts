/**
 * GmailDriver — strictly opt-in Gmail ingestion.
 *
 * The selector contract: the driver refuses
 * to sync until the user explicitly selects labels, senders, and/or
 * threads — there is no whole-mailbox default, structurally. Incremental
 * sync runs `users.history.list` from the stored `historyId`; when Google
 * reports the id expired (404), the driver re-bootstraps from the current
 * profile historyId and flags `cursorInvalidated`.
 *
 * Selector semantics: a message is ingested when it matches ANY selected
 * selector (union of subscriptions). Labels/senders also scope the
 * bootstrap search query; a threads-only selection filters incrementally
 * (Gmail search has no thread operator), so it picks up new mail from the
 * connect time onward.
 *
 * Label selectors are resolved against `labels.list` every sync: Gmail
 * search takes label NAMES while `message.labelIds` carries label IDS
 * (they only coincide for system labels like INBOX), so the user's
 * selector — stored as either — is mapped to the name for the bootstrap
 * query and to the id for the incremental filter.
 *
 * Batch caps never lose data silently: when a sync stops at
 * `MAX_PAGES_PER_SYNC`/`MAX_MESSAGES_PER_SYNC` with pages remaining, the
 * result carries `hasMore: true` and a cursor that resumes the same
 * listing; the historyId only advances once the listing drains.
 *
 * @module nomior/connectors/google/GmailDriver
 */
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ConnectorDriver, ConnectorHealth, ConnectorInstance } from "../ConnectorDriver.ts";
import {
  ConnectorDriverError,
  ConnectorSelectorRequiredError,
  ConnectorSyncError,
} from "../Errors.ts";
import {
  type ConnectorAccountId,
  ConnectorDriverKind,
  type ConnectorParticipant,
  type ConnectorRecord,
  type ConnectorSyncResult,
} from "../Records.ts";
import {
  GmailPort,
  type GmailMessage,
  type GmailMessageRef,
  type GoogleApiError,
  GoogleTokenPort,
  isCursorInvalidationError,
  isGoogleApiError,
} from "./GooglePorts.ts";
import { GoogleTokenVault } from "./GoogleTokenVault.ts";

const DRIVER_KIND = ConnectorDriverKind.make("gmail");
const MAX_PAGES_PER_SYNC = 50;
const MAX_MESSAGES_PER_SYNC = 500;

const emptyStringArray = Schema.Array(Schema.String).pipe(
  Schema.withDecodingDefault(Effect.succeed([] as ReadonlyArray<string>)),
);

export const GmailConnectorConfig = Schema.Struct({
  /** Label names or ids the user opted into (resolved via `labels.list`). */
  labels: emptyStringArray,
  /**
   * Sender selectors the user opted into: a full address matches exactly,
   * `@domain.com` / `domain.com` match any address at that domain.
   */
  senders: emptyStringArray,
  /** Thread ids the user opted into. */
  threadIds: emptyStringArray,
});
export type GmailConnectorConfig = typeof GmailConnectorConfig.Type;

const decodeConfig = Schema.decodeUnknownSync(GmailConnectorConfig);

/**
 * Persisted sync position. `historyId` alone = incremental from there.
 * `bootstrapPageToken` = a bootstrap walk still draining toward the
 * captured baseline `historyId`. `historyPageToken` = an incremental
 * history listing that hit a batch cap; `historyId` stays the start until
 * the listing drains.
 */
const GmailCursor = Schema.Struct({
  historyId: Schema.String,
  bootstrapPageToken: Schema.optionalKey(Schema.String),
  historyPageToken: Schema.optionalKey(Schema.String),
});
const decodeCursor = Schema.decodeUnknownEffect(Schema.fromJsonString(GmailCursor));
const encodeCursor = Schema.encodeSync(Schema.fromJsonString(GmailCursor));

export type GmailDriverEnv = GmailPort | GoogleTokenVault | GoogleTokenPort;

const hasAnySelector = (config: GmailConnectorConfig): boolean =>
  config.labels.length > 0 || config.senders.length > 0 || config.threadIds.length > 0;

/** Label selectors mapped for both sides of the Gmail API. */
interface ResolvedLabelSelectors {
  /** Label ids to match against `message.labelIds`. */
  readonly ids: ReadonlySet<string>;
  /** Label names for `label:` search terms. */
  readonly queryNames: ReadonlyArray<string>;
}

const quoteQueryTerm = (name: string): string => (/\s/.test(name) ? `"${name}"` : name);

const buildBootstrapQuery = (
  config: GmailConnectorConfig,
  labels: ResolvedLabelSelectors,
): string => {
  const terms = [
    ...config.senders.map((sender) => `from:${sender}`),
    ...labels.queryNames.map((name) => `label:${quoteQueryTerm(name)}`),
  ];
  return terms.join(" OR ");
};

/** Bare address out of an RFC 5322 `From` value ("Sam <sam@x.y>" → "sam@x.y"). */
const extractAddress = (raw: string): string => {
  const angled = /<([^>]+)>/.exec(raw);
  return (angled?.[1] ?? raw).trim().toLowerCase();
};

const senderMatches = (selectors: ReadonlyArray<string>, from: string): boolean => {
  const address = extractAddress(from);
  return selectors.some((selector) => {
    const wanted = selector.trim().toLowerCase();
    if (wanted === "") {
      return false;
    }
    // Full address → exact match; domain forms → anchored at the "@" so
    // `an@example.com` can never overmatch `ivan@example.com`.
    if (wanted.startsWith("@")) {
      return address.endsWith(wanted);
    }
    if (wanted.includes("@")) {
      return address === wanted;
    }
    return address.endsWith(`@${wanted}`);
  });
};

const matchesSelectors = (
  config: GmailConnectorConfig,
  labelIds: ReadonlySet<string>,
  message: GmailMessage,
): boolean => {
  if (config.threadIds.includes(message.threadId)) {
    return true;
  }
  if (labelIds.size > 0 && (message.labelIds ?? []).some((labelId) => labelIds.has(labelId))) {
    return true;
  }
  if (
    config.senders.length > 0 &&
    message.from !== undefined &&
    senderMatches(config.senders, message.from)
  ) {
    return true;
  }
  return false;
};

const parseAddressList = (raw: string | undefined): Array<ConnectorParticipant> => {
  if (raw === undefined || raw.trim() === "") {
    return [];
  }
  return raw.split(",").flatMap((part) => {
    const trimmed = part.trim();
    if (trimmed === "") {
      return [];
    }
    const angled = /^(.*?)<([^>]+)>$/.exec(trimmed);
    if (angled !== null) {
      const name = (angled[1] ?? "").trim().replace(/^["']|["']$/g, "");
      const email = (angled[2] ?? "").trim();
      return [{ ...(name === "" ? {} : { name }), email }];
    }
    return [{ email: trimmed }];
  });
};

const normalizeMessage = (
  accountId: ConnectorAccountId,
  message: GmailMessage,
): ConnectorRecord => {
  const sourceId = `message:${message.id}`;
  const internalDateMs =
    message.internalDate === undefined ? Number.NaN : Number(message.internalDate);
  const startedAt = Number.isFinite(internalDateMs)
    ? DateTime.formatIso(DateTime.makeUnsafe(internalDateMs))
    : undefined;
  const text = [message.subject ?? "", message.snippet ?? ""]
    .filter((part) => part !== "")
    .join("\n");
  return {
    source: {
      sourceId,
      kind: "mail_message",
      title: message.subject ?? "(no subject)",
      ...(startedAt === undefined ? {} : { startedAt }),
      participants: [...parseAddressList(message.from), ...parseAddressList(message.to)],
      links: { mailThreadId: message.threadId },
      provenance: {
        driverKind: DRIVER_KIND,
        accountId,
        externalId: message.id,
      },
    },
    chunks: text === "" ? [] : [{ chunkId: `${sourceId}/chunk/0`, sourceId, index: 0, text }],
  };
};

export const GmailDriver: ConnectorDriver<GmailConnectorConfig, GmailDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "Gmail",
    supportsMultipleAccounts: true,
  },
  configSchema: GmailConnectorConfig,
  defaultConfig: (): GmailConnectorConfig => decodeConfig({}),
  create: ({ accountId, displayName, config }) =>
    Effect.gen(function* () {
      const gmail = yield* GmailPort;
      const tokenPort = yield* GoogleTokenPort;
      const vault = yield* GoogleTokenVault;

      const syncError = (operation: string, detail?: string, cause?: unknown) =>
        new ConnectorSyncError({
          driverKind: DRIVER_KIND,
          accountId,
          operation,
          ...(detail === undefined ? {} : { detail }),
          ...(cause === undefined ? {} : { cause }),
        });

      const resolveLabelSelectors: Effect.Effect<ResolvedLabelSelectors, GoogleApiError> =
        Effect.gen(function* () {
          if (config.labels.length === 0) {
            return { ids: new Set<string>(), queryNames: [] };
          }
          const known = yield* gmail.listLabels({ accountId });
          const ids = new Set<string>();
          const queryNames: Array<string> = [];
          for (const selector of config.labels) {
            const match = known.find(
              (label) =>
                label.id === selector || label.name.toLowerCase() === selector.toLowerCase(),
            );
            if (match === undefined) {
              // Unknown selector: keep it verbatim on both sides. It
              // matches nothing until such a label exists — but is never
              // silently dropped from the query.
              ids.add(selector);
              queryNames.push(selector);
            } else {
              ids.add(match.id);
              queryNames.push(match.name);
            }
          }
          return { ids, queryNames };
        });

      const fetchAndFilter = (
        labels: ResolvedLabelSelectors,
        refs: ReadonlyArray<GmailMessageRef>,
      ) =>
        Effect.gen(function* () {
          const seen = new Set<string>();
          const records: Array<ConnectorRecord> = [];
          for (const ref of refs) {
            if (seen.has(ref.id)) {
              continue;
            }
            seen.add(ref.id);
            const message = yield* gmail.getMessage({ accountId, id: ref.id });
            if (matchesSelectors(config, labels.ids, message)) {
              records.push(normalizeMessage(accountId, message));
            }
          }
          return records;
        });

      /**
       * Full baseline: capture the profile historyId FIRST (so anything
       * arriving during the walk lands in the next incremental window),
       * then page the selector-scoped search. A batch cap mid-walk
       * persists the page position and reports `hasMore` — the baseline
       * historyId is carried through the resume cursor untouched.
       */
      const bootstrap = (
        resume: { readonly baselineHistoryId: string; readonly pageToken: string } | undefined,
      ): Effect.Effect<ConnectorSyncResult, GoogleApiError> =>
        Effect.gen(function* () {
          const labels = yield* resolveLabelSelectors;
          const baselineHistoryId =
            resume === undefined
              ? (yield* gmail.getProfile({ accountId })).historyId
              : resume.baselineHistoryId;
          const query = buildBootstrapQuery(config, labels);
          const refs: Array<GmailMessageRef> = [];
          let pageToken: string | undefined = resume?.pageToken;
          if (query !== "") {
            for (let page = 0; page < MAX_PAGES_PER_SYNC; page += 1) {
              const result = yield* gmail.listMessages({
                accountId,
                query,
                ...(pageToken === undefined ? {} : { pageToken }),
              });
              refs.push(...result.messages);
              pageToken = result.nextPageToken;
              if (pageToken === undefined || refs.length >= MAX_MESSAGES_PER_SYNC) {
                break;
              }
            }
          } else {
            pageToken = undefined;
          }
          const records = yield* fetchAndFilter(labels, refs);
          if (pageToken !== undefined) {
            return {
              records,
              nextCursor: encodeCursor({
                historyId: baselineHistoryId,
                bootstrapPageToken: pageToken,
              }),
              cursorInvalidated: false,
              hasMore: true,
            } satisfies ConnectorSyncResult;
          }
          return {
            records,
            nextCursor: encodeCursor({ historyId: baselineHistoryId }),
            cursorInvalidated: false,
          } satisfies ConnectorSyncResult;
        });

      const incremental = (
        startHistoryId: string,
        resumePageToken: string | undefined,
      ): Effect.Effect<ConnectorSyncResult, GoogleApiError> =>
        Effect.gen(function* () {
          const labels = yield* resolveLabelSelectors;
          const refs: Array<GmailMessageRef> = [];
          let pageToken = resumePageToken;
          let latestHistoryId = startHistoryId;
          let drained = false;
          for (let page = 0; page < MAX_PAGES_PER_SYNC; page += 1) {
            const result = yield* gmail.listHistory({
              accountId,
              startHistoryId,
              ...(pageToken === undefined ? {} : { pageToken }),
            });
            refs.push(...result.messagesAdded, ...(result.labelsAdded ?? []));
            if (result.historyId !== undefined) {
              latestHistoryId = result.historyId;
            }
            pageToken = result.nextPageToken;
            if (pageToken === undefined) {
              drained = true;
              break;
            }
            if (refs.length >= MAX_MESSAGES_PER_SYNC) {
              break;
            }
          }
          const records = yield* fetchAndFilter(labels, refs);
          if (!drained && pageToken !== undefined) {
            // Cap hit mid-listing: persist the page position; the
            // historyId advances only once the listing drains.
            return {
              records,
              nextCursor: encodeCursor({
                historyId: startHistoryId,
                historyPageToken: pageToken,
              }),
              cursorInvalidated: false,
              hasMore: true,
            } satisfies ConnectorSyncResult;
          }
          return {
            records,
            nextCursor: encodeCursor({ historyId: latestHistoryId }),
            cursorInvalidated: false,
          } satisfies ConnectorSyncResult;
        });

      /**
       * Full resync fallback for a dead sync position: an expired
       * historyId (404) or a stale/invalid page token (Gmail reports 400).
       * Applied only to cursor-carrying paths, so a fresh bootstrap's own
       * failures still surface directly.
       */
      const withRebootstrapOnInvalidation = (
        base: Effect.Effect<ConnectorSyncResult, GoogleApiError>,
      ): Effect.Effect<ConnectorSyncResult, GoogleApiError> =>
        base.pipe(
          Effect.catchIf(
            (error): error is GoogleApiError =>
              isGoogleApiError(error) && (isCursorInvalidationError(error) || error.status === 400),
            () =>
              bootstrap(undefined).pipe(
                Effect.map((full) => ({ ...full, cursorInvalidated: true })),
              ),
          ),
        );

      const sync: ConnectorInstance["sync"] = ({ cursor }) =>
        Effect.gen(function* () {
          if (!hasAnySelector(config)) {
            // Opt-in contract: no selector, no sync — ever.
            return yield* new ConnectorSelectorRequiredError({
              driverKind: DRIVER_KIND,
              accountId,
              detail: "select labels, senders, or threads to sync (no whole-mailbox default)",
            });
          }

          let decodedCursor: typeof GmailCursor.Type | undefined;
          let staleCursor = false;
          if (cursor !== null) {
            const decoded = yield* decodeCursor(cursor).pipe(
              Effect.map(Option.some),
              Effect.orElseSucceed(() => Option.none<typeof GmailCursor.Type>()),
            );
            if (Option.isSome(decoded)) {
              decodedCursor = decoded.value;
            } else {
              staleCursor = true;
            }
          }

          const base =
            decodedCursor === undefined
              ? bootstrap(undefined)
              : decodedCursor.bootstrapPageToken !== undefined
                ? withRebootstrapOnInvalidation(
                    bootstrap({
                      baselineHistoryId: decodedCursor.historyId,
                      pageToken: decodedCursor.bootstrapPageToken,
                    }),
                  )
                : withRebootstrapOnInvalidation(
                    incremental(decodedCursor.historyId, decodedCursor.historyPageToken),
                  );

          const result = yield* base.pipe(
            Effect.mapError((error) =>
              isGoogleApiError(error) ? syncError("sync", error.message, error) : error,
            ),
          );
          return staleCursor ? { ...result, cursorInvalidated: true } : result;
        });

      const health: Effect.Effect<ConnectorHealth> = vault.get(accountId).pipe(
        Effect.map((tokens): ConnectorHealth => {
          if (Option.isNone(tokens)) {
            return {
              _tag: "unauthorized",
              detail: "no Google credentials stored for this account; connect it first",
            };
          }
          if (!hasAnySelector(config)) {
            return {
              _tag: "needs-selection",
              detail: "choose labels, senders, or threads to sync",
            };
          }
          return { _tag: "ok" };
        }),
        Effect.orElseSucceed(
          (): ConnectorHealth => ({
            _tag: "unavailable",
            detail: "unable to read the Google token vault",
          }),
        ),
      );

      return {
        accountId,
        driverKind: DRIVER_KIND,
        displayName,
        probe: vault.get(accountId).pipe(
          Effect.map((tokens) => ({
            present: true,
            authorized: Option.isSome(tokens),
            ...(Option.isSome(tokens) ? {} : { detail: "account not connected" }),
          })),
          Effect.orElseSucceed(() => ({
            present: true,
            authorized: false,
            detail: "unable to read the Google token vault",
          })),
        ),
        sync,
        health,
        revoke: Effect.gen(function* () {
          const tokens = yield* vault
            .get(accountId)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isSome(tokens)) {
            yield* tokenPort
              .revokeToken({ token: tokens.value.refreshToken ?? tokens.value.accessToken })
              .pipe(Effect.ignore);
          }
          yield* vault.remove(accountId).pipe(
            Effect.mapError(
              (cause) =>
                new ConnectorDriverError({
                  driverKind: DRIVER_KIND,
                  accountId,
                  detail: "failed to remove stored Google credentials",
                  cause,
                }),
            ),
          );
        }),
      } satisfies ConnectorInstance;
    }),
};
