/**
 * Live implementations of the Google ports over the official `googleapis`
 * package, loaded through a thin dynamic-import seam.
 *
 * The dependency is declared in `apps/server/package.json` but the import
 * is deliberately non-literal: the module is typed here as the minimal
 * surface we call, so the tree compiles (and every sync-loop test runs on
 * fake ports) whether or not the package is installed. Loading fails at
 * runtime with a clear `GoogleApiError` instead of a build break.
 *
 * @module nomior/connectors/google/googleapisRuntime
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { ConnectorAccountId } from "../Records.ts";
import { getFreshGoogleAccessToken, type GoogleAuthError } from "./GoogleAuth.ts";
import {
  GmailPort,
  GoogleApiError,
  GoogleCalendarPort,
  GoogleTokenPort,
  type GoogleTokenSet,
} from "./GooglePorts.ts";
import { GoogleTokenVault } from "./GoogleTokenVault.ts";

/** OAuth client id for this install — provided by settings at wire-up time. */
export class GoogleClientConfig extends Context.Service<
  GoogleClientConfig,
  {
    readonly clientId: string;
  }
>()("t3/nomior/connectors/google/googleapisRuntime/GoogleClientConfig") {}

// --- Thin type seam over the `googleapis` / `google-auth-library` surface ---

interface OAuth2CredentialsSeam {
  readonly access_token?: string | null;
  readonly refresh_token?: string | null;
  readonly expiry_date?: number | null;
  readonly scope?: string | null;
}

// Seam shapes verified against googleapis@176 / google-auth-library v11
// typings (2026-08-29). This layer is the one piece of the connector that
// can only be exercised against the real SDK — verify these shapes (and
// the error-status extraction below) on first install.
interface OAuth2ClientSeam {
  setCredentials(credentials: {
    readonly access_token?: string;
    readonly refresh_token?: string;
  }): void;
  readonly credentials: OAuth2CredentialsSeam;
  getToken(options: {
    readonly code: string;
    readonly codeVerifier: string;
    readonly redirect_uri: string;
  }): Promise<{
    readonly tokens: OAuth2CredentialsSeam;
  }>;
  /** Refreshes off `credentials.refresh_token` and updates `credentials`. */
  getAccessToken(): Promise<{ readonly token?: string | null }>;
  revokeToken(token: string): Promise<unknown>;
}

interface CalendarEventsListParams {
  readonly calendarId: string;
  readonly singleEvents: boolean;
  readonly maxResults: number;
  readonly syncToken?: string;
  readonly timeMin?: string;
  readonly pageToken?: string;
}

interface CalendarClientSeam {
  readonly events: {
    list(params: CalendarEventsListParams): Promise<{
      readonly data: {
        readonly items?: ReadonlyArray<{
          readonly id?: string | null;
          readonly status?: string | null;
          readonly summary?: string | null;
          readonly start?: { readonly dateTime?: string | null; readonly date?: string | null };
          readonly end?: { readonly dateTime?: string | null; readonly date?: string | null };
          readonly attendees?: ReadonlyArray<{
            readonly email?: string | null;
            readonly displayName?: string | null;
          }>;
          readonly recurringEventId?: string | null;
          readonly updated?: string | null;
        }>;
        readonly nextPageToken?: string | null;
        readonly nextSyncToken?: string | null;
      };
    }>;
  };
}

interface GmailClientSeam {
  readonly users: {
    getProfile(params: { readonly userId: string }): Promise<{
      readonly data: {
        readonly emailAddress?: string | null;
        readonly historyId?: string | null;
      };
    }>;
    readonly history: {
      list(params: {
        readonly userId: string;
        readonly startHistoryId: string;
        readonly historyTypes?: ReadonlyArray<string>;
        readonly pageToken?: string;
      }): Promise<{
        readonly data: {
          readonly history?: ReadonlyArray<{
            readonly messagesAdded?: ReadonlyArray<{
              readonly message?: {
                readonly id?: string | null;
                readonly threadId?: string | null;
              };
            }>;
            readonly labelsAdded?: ReadonlyArray<{
              readonly message?: {
                readonly id?: string | null;
                readonly threadId?: string | null;
              };
            }>;
          }>;
          readonly nextPageToken?: string | null;
          readonly historyId?: string | null;
        };
      }>;
    };
    readonly labels: {
      list(params: { readonly userId: string }): Promise<{
        readonly data: {
          readonly labels?: ReadonlyArray<{
            readonly id?: string | null;
            readonly name?: string | null;
          }>;
        };
      }>;
    };
    readonly messages: {
      list(params: {
        readonly userId: string;
        readonly q: string;
        readonly maxResults?: number;
        readonly pageToken?: string;
      }): Promise<{
        readonly data: {
          readonly messages?: ReadonlyArray<{
            readonly id?: string | null;
            readonly threadId?: string | null;
          }>;
          readonly nextPageToken?: string | null;
        };
      }>;
      get(params: {
        readonly userId: string;
        readonly id: string;
        readonly format: string;
        readonly metadataHeaders?: ReadonlyArray<string>;
      }): Promise<{
        readonly data: {
          readonly id?: string | null;
          readonly threadId?: string | null;
          readonly labelIds?: ReadonlyArray<string> | null;
          readonly internalDate?: string | null;
          readonly snippet?: string | null;
          readonly payload?: {
            readonly headers?: ReadonlyArray<{
              readonly name?: string | null;
              readonly value?: string | null;
            }>;
          };
        };
      }>;
    };
  };
}

interface GoogleApisModuleSeam {
  readonly google: {
    calendar(options: { readonly version: "v3"; readonly auth: unknown }): CalendarClientSeam;
    gmail(options: { readonly version: "v1"; readonly auth: unknown }): GmailClientSeam;
    readonly auth: {
      readonly OAuth2: new (options: {
        readonly clientId: string;
        readonly redirectUri?: string;
      }) => OAuth2ClientSeam;
    };
  };
}

// The specifier is intentionally non-literal so the compiler does not
// require the package to be installed to typecheck this tree.
const GOOGLEAPIS_SPECIFIER = "googleapis";

const loadGoogleApis = (operation: string) =>
  Effect.tryPromise({
    try: () => import(GOOGLEAPIS_SPECIFIER) as Promise<GoogleApisModuleSeam>,
    catch: (cause) =>
      new GoogleApiError({
        status: 0,
        operation,
        detail: "the googleapis package is not installed",
        cause,
      }),
  });

/**
 * Extract the HTTP status from a gaxios/googleapis rejection. gaxios v7
 * (what googleapis@176 ships) puts it on `error.status` (number) with
 * `error.code` a string; older client shapes used a numeric `code`.
 * Checked in order: `status`, `response.status`, numeric `code`, numeric
 * string `code` — anything else maps to 0 (non-HTTP failure).
 */
const extractHttpStatus = (cause: unknown): number => {
  if (typeof cause !== "object" || cause === null) {
    return 0;
  }
  const error = cause as {
    readonly status?: unknown;
    readonly code?: unknown;
    readonly response?: { readonly status?: unknown };
  };
  if (typeof error.status === "number" && Number.isInteger(error.status)) {
    return error.status;
  }
  if (typeof error.response?.status === "number" && Number.isInteger(error.response.status)) {
    return error.response.status;
  }
  if (typeof error.code === "number" && Number.isInteger(error.code)) {
    return error.code;
  }
  if (typeof error.code === "string" && /^[1-5]\d\d$/.test(error.code)) {
    return Number(error.code);
  }
  return 0;
};

const toGoogleApiError = (operation: string) => (cause: unknown) =>
  new GoogleApiError({ status: extractHttpStatus(cause), operation, cause });

const toTokenSet = (credentials: {
  readonly access_token?: string | null;
  readonly refresh_token?: string | null;
  readonly expiry_date?: number | null;
  readonly scope?: string | null;
}): GoogleTokenSet => ({
  accessToken: credentials.access_token ?? "",
  ...(credentials.refresh_token === null || credentials.refresh_token === undefined
    ? {}
    : { refreshToken: credentials.refresh_token }),
  ...(credentials.expiry_date === null || credentials.expiry_date === undefined
    ? {}
    : { expiryMs: Math.round(credentials.expiry_date) }),
  scopes: (credentials.scope ?? "").split(" ").filter((scope) => scope !== ""),
});

export const GoogleTokenPortLive = Layer.sync(GoogleTokenPort, () =>
  GoogleTokenPort.of({
    exchangeAuthorizationCode: (input) =>
      loadGoogleApis("token.exchange").pipe(
        Effect.flatMap((module) =>
          Effect.tryPromise({
            try: async () => {
              const client = new module.google.auth.OAuth2({
                clientId: input.clientId,
                redirectUri: input.redirectUri,
              });
              const { tokens } = await client.getToken({
                code: input.code,
                codeVerifier: input.codeVerifier,
                redirect_uri: input.redirectUri,
              });
              return toTokenSet(tokens);
            },
            catch: toGoogleApiError("token.exchange"),
          }),
        ),
      ),
    refreshAccessToken: (input) =>
      loadGoogleApis("token.refresh").pipe(
        Effect.flatMap((module) =>
          Effect.tryPromise({
            try: async () => {
              const client = new module.google.auth.OAuth2({ clientId: input.clientId });
              client.setCredentials({ refresh_token: input.refreshToken });
              // getAccessToken() refreshes off credentials.refresh_token
              // and writes the fresh set back onto `credentials`
              // (refreshAccessToken() is deprecated in v11).
              await client.getAccessToken();
              return toTokenSet(client.credentials);
            },
            catch: toGoogleApiError("token.refresh"),
          }),
        ),
      ),
    revokeToken: (input) =>
      loadGoogleApis("token.revoke").pipe(
        Effect.flatMap((module) =>
          Effect.tryPromise({
            try: async () => {
              const client = new module.google.auth.OAuth2({ clientId: "" });
              await client.revokeToken(input.token);
            },
            catch: toGoogleApiError("token.revoke"),
          }),
        ),
        Effect.asVoid,
      ),
  }),
);

const authedClient = Effect.fnUntraced(function* (input: {
  readonly accountId: ConnectorAccountId;
  readonly operation: string;
}) {
  const { clientId } = yield* GoogleClientConfig;
  const module = yield* loadGoogleApis(input.operation);
  const accessToken = yield* getFreshGoogleAccessToken({
    accountId: input.accountId,
    clientId,
  }).pipe(
    Effect.mapError(
      (cause: GoogleAuthError) =>
        new GoogleApiError({ status: 401, operation: input.operation, cause }),
    ),
  );
  const auth = new module.google.auth.OAuth2({ clientId });
  auth.setCredentials({ access_token: accessToken });
  return { module, auth };
});

export const GoogleCalendarPortLive = Layer.effect(
  GoogleCalendarPort,
  Effect.gen(function* () {
    const services = yield* Effect.context<
      GoogleClientConfig | GoogleTokenVault | GoogleTokenPort
    >();
    return GoogleCalendarPort.of({
      listEvents: (input) =>
        authedClient({ accountId: input.accountId, operation: "calendar.events.list" }).pipe(
          Effect.flatMap(({ module, auth }) =>
            Effect.tryPromise({
              try: async () => {
                const calendar = module.google.calendar({ version: "v3", auth });
                const response = await calendar.events.list({
                  calendarId: input.calendarId,
                  singleEvents: true,
                  maxResults: 250,
                  ...(input.syncToken === undefined ? {} : { syncToken: input.syncToken }),
                  ...(input.timeMin === undefined ? {} : { timeMin: input.timeMin }),
                  ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
                });
                const data = response.data;
                return {
                  items: (data.items ?? []).flatMap((item) =>
                    item.id === null || item.id === undefined
                      ? []
                      : [
                          {
                            id: item.id,
                            ...(item.status === null || item.status === undefined
                              ? {}
                              : { status: item.status }),
                            ...(item.summary === null || item.summary === undefined
                              ? {}
                              : { summary: item.summary }),
                            ...(item.start === undefined
                              ? {}
                              : {
                                  start: {
                                    ...(item.start.dateTime === null ||
                                    item.start.dateTime === undefined
                                      ? {}
                                      : { dateTime: item.start.dateTime }),
                                    ...(item.start.date === null || item.start.date === undefined
                                      ? {}
                                      : { date: item.start.date }),
                                  },
                                }),
                            ...(item.end === undefined
                              ? {}
                              : {
                                  end: {
                                    ...(item.end.dateTime === null ||
                                    item.end.dateTime === undefined
                                      ? {}
                                      : { dateTime: item.end.dateTime }),
                                    ...(item.end.date === null || item.end.date === undefined
                                      ? {}
                                      : { date: item.end.date }),
                                  },
                                }),
                            ...(item.attendees === undefined
                              ? {}
                              : {
                                  attendees: item.attendees.map((attendee) => ({
                                    ...(attendee.email === null || attendee.email === undefined
                                      ? {}
                                      : { email: attendee.email }),
                                    ...(attendee.displayName === null ||
                                    attendee.displayName === undefined
                                      ? {}
                                      : { displayName: attendee.displayName }),
                                  })),
                                }),
                            ...(item.recurringEventId === null ||
                            item.recurringEventId === undefined
                              ? {}
                              : { recurringEventId: item.recurringEventId }),
                            ...(item.updated === null || item.updated === undefined
                              ? {}
                              : { updated: item.updated }),
                          },
                        ],
                  ),
                  ...(data.nextPageToken === null || data.nextPageToken === undefined
                    ? {}
                    : { nextPageToken: data.nextPageToken }),
                  ...(data.nextSyncToken === null || data.nextSyncToken === undefined
                    ? {}
                    : { nextSyncToken: data.nextSyncToken }),
                };
              },
              catch: toGoogleApiError("calendar.events.list"),
            }),
          ),
          Effect.provideContext(services),
        ),
    });
  }),
);

const headerValue = (
  headers: ReadonlyArray<{ readonly name?: string | null; readonly value?: string | null }>,
  name: string,
): string | undefined =>
  headers.find((header) => header.name?.toLowerCase() === name.toLowerCase())?.value ?? undefined;

export const GmailPortLive = Layer.effect(
  GmailPort,
  Effect.gen(function* () {
    const services = yield* Effect.context<
      GoogleClientConfig | GoogleTokenVault | GoogleTokenPort
    >();
    const withGmail = <A>(
      input: { readonly accountId: ConnectorAccountId; readonly operation: string },
      run: (gmail: GmailClientSeam) => Promise<A>,
    ) =>
      authedClient({ accountId: input.accountId, operation: input.operation }).pipe(
        Effect.flatMap(({ module, auth }) =>
          Effect.tryPromise({
            try: () => run(module.google.gmail({ version: "v1", auth })),
            catch: toGoogleApiError(input.operation),
          }),
        ),
        Effect.provideContext(services),
      );

    return GmailPort.of({
      getProfile: ({ accountId }) =>
        withGmail({ accountId, operation: "gmail.getProfile" }, async (gmail) => {
          const response = await gmail.users.getProfile({ userId: "me" });
          return {
            emailAddress: response.data.emailAddress ?? "",
            historyId: response.data.historyId ?? "",
          };
        }),
      listHistory: (input) =>
        withGmail(
          { accountId: input.accountId, operation: "gmail.history.list" },
          async (gmail) => {
            // labelAdded is requested alongside messageAdded so labeling an
            // EXISTING message with a selected label still ingests it — the
            // driver's selector filter decides relevance either way.
            const response = await gmail.users.history.list({
              userId: "me",
              startHistoryId: input.startHistoryId,
              historyTypes: ["messageAdded", "labelAdded"],
              ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
            });
            const data = response.data;
            const collectRefs = (
              entries: ReadonlyArray<{
                readonly message?: {
                  readonly id?: string | null;
                  readonly threadId?: string | null;
                };
              }>,
            ) =>
              entries.flatMap((added) =>
                added.message?.id === null ||
                added.message?.id === undefined ||
                added.message.threadId === null ||
                added.message.threadId === undefined
                  ? []
                  : [{ id: added.message.id, threadId: added.message.threadId }],
              );
            return {
              messagesAdded: (data.history ?? []).flatMap((entry) =>
                collectRefs(entry.messagesAdded ?? []),
              ),
              labelsAdded: (data.history ?? []).flatMap((entry) =>
                collectRefs(entry.labelsAdded ?? []),
              ),
              ...(data.nextPageToken === null || data.nextPageToken === undefined
                ? {}
                : { nextPageToken: data.nextPageToken }),
              ...(data.historyId === null || data.historyId === undefined
                ? {}
                : { historyId: data.historyId }),
            };
          },
        ),
      listLabels: ({ accountId }) =>
        withGmail({ accountId, operation: "gmail.labels.list" }, async (gmail) => {
          const response = await gmail.users.labels.list({ userId: "me" });
          return (response.data.labels ?? []).flatMap((label) =>
            label.id === null ||
            label.id === undefined ||
            label.name === null ||
            label.name === undefined
              ? []
              : [{ id: label.id, name: label.name }],
          );
        }),
      listMessages: (input) =>
        withGmail(
          { accountId: input.accountId, operation: "gmail.messages.list" },
          async (gmail) => {
            const response = await gmail.users.messages.list({
              userId: "me",
              q: input.query,
              maxResults: 100,
              ...(input.pageToken === undefined ? {} : { pageToken: input.pageToken }),
            });
            const data = response.data;
            return {
              messages: (data.messages ?? []).flatMap((message) =>
                message.id === null ||
                message.id === undefined ||
                message.threadId === null ||
                message.threadId === undefined
                  ? []
                  : [{ id: message.id, threadId: message.threadId }],
              ),
              ...(data.nextPageToken === null || data.nextPageToken === undefined
                ? {}
                : { nextPageToken: data.nextPageToken }),
            };
          },
        ),
      getMessage: (input) =>
        withGmail(
          { accountId: input.accountId, operation: "gmail.messages.get" },
          async (gmail) => {
            const response = await gmail.users.messages.get({
              userId: "me",
              id: input.id,
              format: "metadata",
              metadataHeaders: ["Subject", "From", "To", "Date"],
            });
            const data = response.data;
            const headers = data.payload?.headers ?? [];
            const subject = headerValue(headers, "Subject");
            const from = headerValue(headers, "From");
            const to = headerValue(headers, "To");
            return {
              id: data.id ?? input.id,
              threadId: data.threadId ?? "",
              ...(data.labelIds === null || data.labelIds === undefined
                ? {}
                : { labelIds: data.labelIds }),
              ...(data.internalDate === null || data.internalDate === undefined
                ? {}
                : { internalDate: data.internalDate }),
              ...(subject === undefined ? {} : { subject }),
              ...(from === undefined ? {} : { from }),
              ...(to === undefined ? {} : { to }),
              ...(data.snippet === null || data.snippet === undefined
                ? {}
                : { snippet: data.snippet }),
            };
          },
        ),
    });
  }),
);
