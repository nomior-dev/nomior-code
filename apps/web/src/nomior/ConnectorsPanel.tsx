import {
  AlertTriangleIcon,
  ChevronRightIcon,
  LinkIcon,
  MonitorOffIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "../lib/utils";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardPanel } from "../components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../components/ui/collapsible";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../components/ui/empty";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { readLocalApi } from "../localApi";
import {
  accountsSignature,
  advancedSectionOpen,
  anarlogPresentation,
  authorizationUrlToOpen,
  clientIdHintLabel,
  clientIdSaveIntent,
  connectBlockedReason,
  connectorKindDescription,
  connectorKindLabel,
  formatIngestedCount,
  formatLastSynced,
  isGoogleConnector,
  orderAccounts,
  showsDetail,
  statusPresentation,
} from "./connectors.logic";
import { fixtureNomiorPort } from "./fixtures";
import { useNomiorPort } from "./port";
import { PortErrorState } from "./PortErrorState";
import type { ConnectorKind, ConnectorsOverview } from "./types";
import { usePortData } from "./usePortData";

/** A value the connector never supplied reads as muted italics, everywhere. */
const UNKNOWN_CLASS = "text-muted-foreground/80 italic";

/**
 * The kind the one button connects.
 *
 * Calendar carries the surface people come here for, and its scope is the one
 * Google treats as merely sensitive. Gmail is a restricted scope — a separate
 * consent, and for anyone shipping their own client id a separate security
 * review — so it stays under Advanced rather than in the default path.
 */
const PRIMARY_GOOGLE_KIND: ConnectorKind = "googleCalendar";

/** Scope keys: one action can be in flight, and its result renders where it happened. */
export const CLIENT_ID_SCOPE = "google-client-id";
const ACCOUNT_SCOPE_PREFIX = "account:";
export const connectScope = (kind: ConnectorKind) => `connect:${kind}`;
export const accountScope = (accountId: string) => `${ACCOUNT_SCOPE_PREFIX}${accountId}`;

export interface ActionNotice {
  readonly scope: string;
  readonly tone: "success" | "error";
  readonly text: string;
}

export interface ConnectorActionState {
  /** Scope key of the action in flight, or null. */
  readonly pendingScope: string | null;
  readonly notice: ActionNotice | null;
}

function NoticeLine({ notice }: { notice: ActionNotice }) {
  return (
    <p
      className={cn(
        "text-xs",
        notice.tone === "error" ? "text-destructive-foreground" : "text-success-foreground",
      )}
      role="status"
    >
      {notice.text}
    </p>
  );
}

function noticeFor(state: ConnectorActionState, scope: string): ActionNotice | null {
  return state.notice !== null && state.notice.scope === scope ? state.notice : null;
}

/**
 * One Connect button plus, when it cannot run, the sentence saying why. The
 * reason renders as text rather than a tooltip: a disabled control swallows
 * pointer events, so a tooltip on it is a reason nobody can read.
 */
function ConnectRow({
  kind,
  overview,
  state,
  onConnect,
}: {
  kind: ConnectorKind;
  overview: ConnectorsOverview;
  state: ConnectorActionState;
  onConnect: (kind: ConnectorKind) => void;
}) {
  const blocked = connectBlockedReason({
    kind,
    google: overview.google,
    anarlog: overview.anarlog,
    accounts: overview.accounts,
    canStartLocalOAuth: overview.canStartLocalOAuth,
  });
  const scope = connectScope(kind);
  const isPending = state.pendingScope === scope;
  const notice = noticeFor(state, scope);
  const reasonId = `nomior-connect-reason-${kind}`;

  return (
    <div className="flex flex-col gap-1.5 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{connectorKindLabel(kind)}</p>
          <p className="mt-0.5 text-xs text-muted-foreground">{connectorKindDescription(kind)}</p>
        </div>
        <Button
          aria-describedby={blocked === null ? undefined : reasonId}
          disabled={blocked !== null || isPending}
          onClick={() => onConnect(kind)}
          size="xs"
          variant="outline"
        >
          {isPending ? <Spinner className="size-3.5" /> : <LinkIcon className="size-3.5" />}
          {isPending ? "Connecting" : "Connect"}
        </Button>
      </div>
      {blocked === null ? null : (
        <p className="text-xs text-muted-foreground" id={reasonId}>
          {blocked}
        </p>
      )}
      {notice === null ? null : <NoticeLine notice={notice} />}
    </div>
  );
}

/**
 * The whole Google setup, when everything is as it should be: one button.
 *
 * A release build carries its own OAuth client id, so signing in a second or
 * third account is the same single press as the first — Google's own account
 * chooser handles which one. Everything that used to sit here (the client id,
 * Gmail) moved to Advanced, where a fork that has to supply its own project can
 * still find it.
 */
export function GoogleConnectorSection({
  overview,
  state,
  onConnect,
}: {
  overview: ConnectorsOverview;
  state: ConnectorActionState;
  onConnect: (kind: ConnectorKind) => void;
}) {
  const blocked = connectBlockedReason({
    kind: PRIMARY_GOOGLE_KIND,
    google: overview.google,
    anarlog: overview.anarlog,
    accounts: overview.accounts,
    canStartLocalOAuth: overview.canStartLocalOAuth,
  });
  const scope = connectScope(PRIMARY_GOOGLE_KIND);
  const isPending = state.pendingScope === scope;
  const notice = noticeFor(state, scope);
  const reasonId = "nomior-connect-reason-google";

  return (
    <section aria-label="Google" className="flex flex-col gap-2">
      <Button
        aria-describedby={blocked === null ? undefined : reasonId}
        className="self-start"
        disabled={blocked !== null || isPending}
        onClick={() => onConnect(PRIMARY_GOOGLE_KIND)}
        size="sm"
      >
        {isPending ? <Spinner className="size-3.5" /> : <LinkIcon className="size-3.5" />}
        {isPending ? "Waiting for Google" : "Connect Google account"}
      </Button>
      {blocked === null ? null : (
        <p className="text-xs text-muted-foreground" id={reasonId}>
          {blocked}
        </p>
      )}
      {notice === null ? null : <NoticeLine notice={notice} />}
    </section>
  );
}

/**
 * The setup nobody should need: the OAuth client id, and Gmail.
 *
 * Collapsed unless this build has no client id of its own, which is the one
 * case where the page cannot do anything until someone fills it in.
 */
export function AdvancedConnectorSection({
  overview,
  state,
  onSaveClientId,
  onConnect,
}: {
  overview: ConnectorsOverview;
  state: ConnectorActionState;
  onSaveClientId: (value: string) => void;
  onConnect: (kind: ConnectorKind) => void;
}) {
  // null until the user opens or closes it themselves; see advancedSectionOpen.
  const [choice, setChoice] = useState<boolean | null>(null);
  const isOpen = advancedSectionOpen(choice, overview.google);
  const [draft, setDraft] = useState("");
  const intent = clientIdSaveIntent(draft, overview.google);
  const isSaving = state.pendingScope === CLIENT_ID_SCOPE;
  const notice = noticeFor(state, CLIENT_ID_SCOPE);

  return (
    <Collapsible onOpenChange={setChoice} open={isOpen}>
      <CollapsibleTrigger
        className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        render={<button type="button" />}
      >
        <ChevronRightIcon className={cn("size-3.5 transition-transform", isOpen && "rotate-90")} />
        Advanced
      </CollapsibleTrigger>
      <CollapsibleContent>
        <Card className="mt-3">
          <CardPanel className="flex flex-col gap-3 p-4">
            <div className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2">
                <Label htmlFor="nomior-google-client-id">OAuth client id</Label>
                <Badge size="sm" variant={overview.google.configured ? "success" : "secondary"}>
                  {clientIdHintLabel(overview.google)}
                </Badge>
              </div>
              <p className="text-xs text-muted-foreground">
                Point this environment at your own Google Cloud project instead of the built-in
                client: create an OAuth 2.0 Client ID of type “Desktop app” and paste it here. It is
                stored on this environment, never in the browser.
              </p>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  autoComplete="off"
                  className="sm:flex-1"
                  disabled={isSaving}
                  id="nomior-google-client-id"
                  onChange={(event) => setDraft(event.currentTarget.value)}
                  placeholder={
                    overview.google.configured
                      ? "Paste a client id to replace the one in use"
                      : "000000000000-xxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com"
                  }
                  spellCheck={false}
                  value={draft}
                />
                <Button
                  className="sm:self-start"
                  disabled={intent === "unchanged" || isSaving}
                  onClick={() => {
                    onSaveClientId(draft);
                    setDraft("");
                  }}
                  size="sm"
                  variant={intent === "clear" ? "destructive-outline" : "outline"}
                >
                  {isSaving ? <Spinner className="size-3.5" /> : null}
                  {intent === "clear" ? "Clear client id" : "Save"}
                </Button>
              </div>
              {intent === "clear" ? (
                <p className="text-xs text-destructive-foreground">
                  The box is empty, so saving clears this environment's client id and Google falls
                  back to the one the build ships with, if it has one. Accounts already connected
                  keep syncing on the tokens they hold.
                </p>
              ) : null}
              {notice === null ? null : <NoticeLine notice={notice} />}
            </div>

            <div className="flex flex-col border-t border-border">
              <ConnectRow kind="gmail" onConnect={onConnect} overview={overview} state={state} />
            </div>
          </CardPanel>
        </Card>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The Anarlog store, which is a file on this environment's machine rather than
 * an account. Its three detections are three different sentences: absent,
 * readable, or found and deliberately left alone.
 */
export function AnarlogConnectorSection({
  overview,
  state,
  onConnect,
}: {
  overview: ConnectorsOverview;
  state: ConnectorActionState;
  onConnect: (kind: ConnectorKind) => void;
}) {
  const presentation = anarlogPresentation(overview.anarlog);

  return (
    <section aria-label="Anarlog" className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Anarlog</h2>

      <Card>
        <CardPanel className="flex flex-col gap-3 p-4">
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">Store</span>
              <Badge size="sm" variant={presentation.tone}>
                {presentation.label}
              </Badge>
            </div>
            <p className="break-words text-xs text-muted-foreground">{presentation.detail}</p>
          </div>
          <div className="flex flex-col border-t border-border">
            <ConnectRow kind="anarlog" onConnect={onConnect} overview={overview} state={state} />
          </div>
        </CardPanel>
      </Card>
    </section>
  );
}

/**
 * One connected account. Disconnect confirms in place rather than in a dialog:
 * the row already says which account it is, and a dialog would move that
 * question away from its answer.
 */
export function ConnectorAccountRow({
  account,
  state,
  onSync,
  onDisconnect,
}: {
  account: ConnectorsOverview["accounts"][number];
  state: ConnectorActionState;
  onSync: (accountId: string) => void;
  onDisconnect: (accountId: string) => void;
}) {
  const [isConfirming, setIsConfirming] = useState(false);
  const status = statusPresentation(account.status);
  const scope = accountScope(account.id);
  const isPending = state.pendingScope === scope;
  const notice = noticeFor(state, scope);

  return (
    <div className="flex flex-col gap-1.5 py-3">
      <div className="flex min-w-0 items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <span className="truncate text-sm font-medium">{account.displayName}</span>
            <Badge size="sm" variant="secondary">
              {connectorKindLabel(account.kind)}
            </Badge>
            <Badge size="sm" variant={status.tone}>
              {status.label}
            </Badge>
          </div>
          <p
            className={cn(
              "mt-0.5 text-xs",
              account.lastSyncedAt === null ? UNKNOWN_CLASS : "text-muted-foreground",
            )}
          >
            {formatLastSynced(account.lastSyncedAt)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            disabled={isPending}
            onClick={() => onSync(account.id)}
            size="xs"
            variant="outline"
          >
            {isPending ? <Spinner className="size-3.5" /> : <RefreshCwIcon className="size-3.5" />}
            Sync
          </Button>
          {isConfirming ? null : (
            <Button
              disabled={isPending}
              onClick={() => setIsConfirming(true)}
              size="xs"
              variant="ghost-muted"
            >
              Disconnect
            </Button>
          )}
        </div>
      </div>

      {status.recovery === null ? null : (
        <p className="text-xs text-muted-foreground">{status.recovery}</p>
      )}
      {showsDetail(account) ? (
        <p className="break-words text-xs text-muted-foreground">{account.detail}</p>
      ) : null}

      {isConfirming ? (
        <div className="flex flex-col gap-2 rounded-lg border border-destructive/32 p-2.5 sm:flex-row sm:items-center">
          <p className="min-w-0 flex-1 text-xs text-muted-foreground">
            Disconnect {account.displayName}? Nomior drops its stored token and stops syncing it.
            Everything already ingested stays.
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            <Button
              disabled={isPending}
              onClick={() => {
                setIsConfirming(false);
                onDisconnect(account.id);
              }}
              size="xs"
              variant="destructive-outline"
            >
              Disconnect
            </Button>
            <Button onClick={() => setIsConfirming(false)} size="xs" variant="ghost-muted">
              Cancel
            </Button>
          </div>
        </div>
      ) : null}

      {notice === null ? null : <NoticeLine notice={notice} />}
    </div>
  );
}

export function ConnectorAccountList({
  overview,
  state,
  onSync,
  onDisconnect,
}: {
  overview: ConnectorsOverview;
  state: ConnectorActionState;
  onSync: (accountId: string) => void;
  onDisconnect: (accountId: string) => void;
}) {
  // A disconnect takes its own row away with it, so its result would vanish
  // with the control that produced it. Outliving the row, it renders here.
  const { notice } = state;
  const orphanNotice =
    notice !== null &&
    notice.scope.startsWith(ACCOUNT_SCOPE_PREFIX) &&
    !overview.accounts.some((account) => accountScope(account.id) === notice.scope)
      ? notice
      : null;

  if (overview.accounts.length === 0) {
    return (
      <div className="flex flex-col gap-2">
        {orphanNotice === null ? null : <NoticeLine notice={orphanNotice} />}
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No accounts connected</EmptyTitle>
            <EmptyDescription>
              Connect one above and Nomior starts pulling from it: calendar events to match recorded
              sessions against, mail to cite as context, and Anarlog's meetings and transcripts.
              Until then every surface shows sample data.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }
  return (
    <div className="flex flex-col">
      {orphanNotice === null ? null : (
        <div className="pb-2">
          <NoticeLine notice={orphanNotice} />
        </div>
      )}
      <div className="flex flex-col divide-y divide-border">
        {orderAccounts(overview.accounts).map((account) => (
          <ConnectorAccountRow
            account={account}
            key={account.id}
            onDisconnect={onDisconnect}
            onSync={onSync}
            state={state}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * The one blocker nobody at a remote browser can clear from where they are
 * standing, said once at the top instead of only inside a disabled button.
 */
export function RemoteOAuthNotice() {
  return (
    <Alert controlAlignment="first-line" variant="warning">
      <MonitorOffIcon />
      <AlertTitle>Google sign-in has to be started on this environment's machine</AlertTitle>
      <AlertDescription>
        Google sends you back to a loopback address on the machine running this environment, and
        this browser is somewhere else, so the sign-in could never finish here. Open Nomior Code on
        that machine to connect a Google account. Everything else on this page — the client id,
        syncing, disconnecting — works from here.
      </AlertDescription>
    </Alert>
  );
}

function ConnectorsSkeleton() {
  return (
    <div className="flex flex-col gap-6">
      <Skeleton className="h-40 w-full rounded-xl" />
      <Skeleton className="h-28 w-full rounded-xl" />
      <Skeleton className="h-24 w-full rounded-lg" />
    </div>
  );
}

/** How often the page re-reads while it waits for a connection to land. */
const WATCH_INTERVAL_MS = 2_000;

/**
 * How long it keeps waiting: long enough for a consent screen with a password
 * and a second factor in it, short enough that an abandoned sign-in stops
 * polling the environment on its own.
 */
const WATCH_TIMEOUT_MS = 5 * 60_000;

export function ConnectorsPanel() {
  const port = useNomiorPort(fixtureNomiorPort);

  const load = useCallback(() => port.listConnectors(), [port]);
  const { data: overview, error, reload } = usePortData(load);

  const [pendingScope, setPendingScope] = useState<string | null>(null);
  const [notice, setNotice] = useState<ActionNotice | null>(null);

  // Bumped to abandon the watch below: a second connect supersedes the first,
  // and unmounting ends it rather than leaving it polling a page nobody is on.
  const watchToken = useRef(0);
  useEffect(() => () => void (watchToken.current += 1), []);

  /**
   * Watch for a connection this page cannot see land. Signing in finishes in a
   * browser and the account's first sync finishes on the server, so the result
   * arrives without anything happening here — the alternative is telling the
   * user to come back and press something, which is the friction this page is
   * meant not to have.
   *
   * It re-reads only when something actually changed, stops once every account
   * it did not know about has synced, and gives up quietly at the deadline:
   * nothing on screen is wrong afterwards, the page has only stopped looking.
   */
  const watchForConnection = useCallback(
    (before: ConnectorsOverview) => {
      const token = (watchToken.current += 1);
      const knownIds = new Set(before.accounts.map((account) => account.id));
      const deadline = Date.now() + WATCH_TIMEOUT_MS;
      let seen = accountsSignature(before.accounts);

      const tick = async () => {
        if (token !== watchToken.current) return;
        let next: ConnectorsOverview | null = null;
        try {
          next = await port.listConnectors();
        } catch {
          // A failed poll is not a failed connection: keep watching.
        }
        if (token !== watchToken.current) return;
        if (next !== null) {
          const signature = accountsSignature(next.accounts);
          if (signature !== seen) {
            seen = signature;
            reload();
          }
          const arrived = next.accounts.filter((account) => !knownIds.has(account.id));
          if (arrived.length > 0 && arrived.every((account) => account.lastSyncedAt !== null)) {
            return;
          }
        }
        if (Date.now() < deadline) window.setTimeout(() => void tick(), WATCH_INTERVAL_MS);
      };

      window.setTimeout(() => void tick(), WATCH_INTERVAL_MS);
    },
    [port, reload],
  );

  /**
   * Every write goes through here so none of them can end silently: the scope
   * takes the spinner, the resolved sentence or the rejection message lands
   * next to the control that fired it, and a success re-reads the overview.
   */
  const run = useCallback(
    (scope: string, action: () => Promise<string>) => {
      setPendingScope(scope);
      setNotice(null);
      action().then(
        (text) => {
          setPendingScope(null);
          setNotice({ scope, tone: "success", text });
          reload();
        },
        (cause: unknown) => {
          setPendingScope(null);
          setNotice({
            scope,
            tone: "error",
            text: cause instanceof Error ? cause.message : String(cause),
          });
        },
      );
    },
    [reload],
  );

  const handleSaveClientId = useCallback(
    (value: string) => {
      const trimmed = value.trim();
      run(CLIENT_ID_SCOPE, async () => {
        await port.setGoogleClientId(trimmed);
        return trimmed.length === 0
          ? "Client id cleared. Google connectors cannot be connected until you add one."
          : "Client id saved.";
      });
    },
    [port, run],
  );

  const handleConnect = useCallback(
    (kind: ConnectorKind) => {
      if (overview === null) return;
      run(connectScope(kind), async () => {
        const url = authorizationUrlToOpen(await port.connectConnector(kind));
        if (url === null) {
          // A Google connector without a sign-in link is a broken response, not
          // a quiet success; a local connector legitimately has nothing to open.
          if (isGoogleConnector(kind)) {
            throw new Error("The server did not return a sign-in link to open.");
          }
          return `${connectorKindLabel(kind)} connected.`;
        }
        const api = readLocalApi();
        if (api === undefined) throw new Error("This client cannot open a browser window.");
        await api.shell.openExternal(url);
        watchForConnection(overview);
        return "Finish signing in with Google. The account appears here on its own.";
      });
    },
    [overview, port, run, watchForConnection],
  );

  const handleSync = useCallback(
    (accountId: string) => {
      run(accountScope(accountId), async () =>
        formatIngestedCount(await port.syncConnector(accountId)),
      );
    },
    [port, run],
  );

  const handleDisconnect = useCallback(
    (accountId: string) => {
      run(accountScope(accountId), async () => {
        await port.disconnectConnector(accountId);
        return "Disconnected.";
      });
    },
    [port, run],
  );

  if (error !== null) {
    return <PortErrorState label="Couldn't load connectors." onRetry={reload} />;
  }

  const state: ConnectorActionState = { pendingScope, notice };

  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-2">
        {port.isFixture ? (
          // Without this the page would claim accounts are connected on a
          // client that has no environment to connect them to.
          <Badge className="self-start" size="sm" variant="warning">
            Sample data
          </Badge>
        ) : null}
        <p className="text-sm text-muted-foreground">
          Where Nomior's own data comes from. Each connector runs on this environment's machine and
          keeps its credentials there.
        </p>
      </div>

      {overview === null ? (
        <ConnectorsSkeleton />
      ) : (
        <>
          {overview.canStartLocalOAuth ? null : <RemoteOAuthNotice />}

          <GoogleConnectorSection onConnect={handleConnect} overview={overview} state={state} />

          <section aria-label="Connected accounts" className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium">Connected accounts</h2>
              {overview.accounts.some((account) => account.status !== "connected") ? (
                <Badge size="sm" variant="warning">
                  <AlertTriangleIcon />
                  Needs attention
                </Badge>
              ) : null}
            </div>
            <ConnectorAccountList
              onDisconnect={handleDisconnect}
              onSync={handleSync}
              overview={overview}
              state={state}
            />
          </section>

          <AnarlogConnectorSection onConnect={handleConnect} overview={overview} state={state} />

          <AdvancedConnectorSection
            onConnect={handleConnect}
            onSaveClientId={handleSaveClientId}
            overview={overview}
            state={state}
          />
        </>
      )}
    </div>
  );
}
