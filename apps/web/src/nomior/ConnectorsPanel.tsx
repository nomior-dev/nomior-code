import {
  AlertTriangleIcon,
  CalendarIcon,
  CheckIcon,
  MailIcon,
  MonitorOffIcon,
  RefreshCwIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "../lib/utils";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import { Spinner } from "../components/ui/spinner";
import { readLocalApi } from "../localApi";
import {
  accountsOfKind,
  accountsSignature,
  authorizationUrlToOpen,
  clientIdHintLabel,
  clientIdSaveIntent,
  connectActionLabel,
  connectBlockedReason,
  connectorKindLabel,
  connectorRowLine,
  connectorRowStatus,
  CONNECTOR_KIND_ORDER,
  formatIngestedCount,
  formatLastSynced,
  needsGoogleSetup,
  showsDetail,
  statusPresentation,
} from "./connectors.logic";
import { fixtureNomiorPort } from "./fixtures";
import { useNomiorPort } from "./port";
import { PortErrorState } from "./PortErrorState";
import type { ConnectorKind, ConnectorsOverview, ProjectOption } from "./types";
import { usePortData } from "./usePortData";

/**
 * One row shape for the whole page: what it is, whether it is working, what you
 * can do about it. Accounts use the same columns as the connector they sit
 * under, so the page reads as one list rather than a stack of panels.
 */
const ROW_GRID =
  "grid grid-cols-[minmax(0,1fr)_9rem] items-center gap-x-4 sm:grid-cols-[minmax(0,1fr)_2rem_9rem]";

/** The action column: same width on every row, so the columns left of it line up. */
const ACTION_CELL = "flex items-center justify-end gap-1";

/** The status column only exists on a wide enough page; the name column always does. */
const STATUS_CELL = "hidden justify-self-center sm:block";

/** Accounts sit under their connector's name, not under a column of their own. */
const ACCOUNT_INDENT = "ps-6.5";

/** Scope keys: one action can be in flight, and its result renders where it happened. */
export const CLIENT_ID_SCOPE = "google-client-id";
const ACCOUNT_SCOPE_PREFIX = "account:";
const CLIENT_ID_NOTE_ID = "nomior-google-client-id";
const REMOTE_HINT_ID = "nomior-remote-oauth";
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

const KIND_ICON = {
  googleCalendar: CalendarIcon,
  gmail: MailIcon,
} as const satisfies Record<ConnectorKind, typeof CalendarIcon>;

/** Tick, warning or dash — the column you scan instead of reading the rows. */
function StatusGlyph({ kind, overview }: { kind: ConnectorKind; overview: ConnectorsOverview }) {
  const status = connectorRowStatus(overview.accounts, kind);
  if (status === "connected") {
    return <CheckIcon aria-label="Connected" className="size-4 text-success-foreground" />;
  }
  if (status === "attention") {
    return <AlertTriangleIcon aria-label="Needs attention" className="size-4 text-warning" />;
  }
  return (
    <span aria-label="Not connected" className="text-muted-foreground/60">
      —
    </span>
  );
}

/**
 * One connector: the thing itself, never its setup.
 *
 * Connecting a second Google account is the same press as the first — Google's
 * own chooser decides which — so the row keeps one button and only its label
 * moves. The accounts it owns render underneath it, because an account is only
 * meaningful as "this connector, signed in as this address".
 */
export function ConnectorRow({
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
  const accounts = accountsOfKind(overview.accounts, kind);
  const availability = {
    kind,
    google: overview.google,
    accounts: overview.accounts,
    canStartLocalOAuth: overview.canStartLocalOAuth,
  };
  const blocked = connectBlockedReason(availability);
  const line = connectorRowLine(availability);
  // The two blockers the page states once, elsewhere. A disabled button still
  // has to point at its reason; it points at the one on screen.
  const pageHintId = !overview.canStartLocalOAuth
    ? REMOTE_HINT_ID
    : needsGoogleSetup(overview.google)
      ? CLIENT_ID_NOTE_ID
      : null;
  const scope = connectScope(kind);
  const isPending = state.pendingScope === scope;
  const notice = noticeFor(state, scope);
  const Icon = KIND_ICON[kind];
  const reasonId = `nomior-connect-reason-${kind}`;

  return (
    <div className="flex flex-col gap-1.5 py-2.5">
      <div className={ROW_GRID}>
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="truncate text-sm">{connectorKindLabel(kind)}</span>
        </div>
        <span className={STATUS_CELL}>
          <StatusGlyph kind={kind} overview={overview} />
        </span>
        <span className={ACTION_CELL}>
          <Button
            aria-describedby={pageHintId ?? (line === null ? undefined : reasonId)}
            disabled={blocked !== null || isPending}
            onClick={() => onConnect(kind)}
            size="xs"
            variant="outline"
          >
            {isPending ? <Spinner className="size-3.5" /> : null}
            {isPending ? "Waiting for Google" : connectActionLabel(accounts.length)}
          </Button>
        </span>
      </div>
      {line === null ? null : (
        <p className="text-xs text-muted-foreground ps-6.5" id={reasonId}>
          {line}
        </p>
      )}
      {notice === null ? null : <NoticeLine notice={notice} />}
    </div>
  );
}

/**
 * One connected account, indented under its connector. Disconnect confirms in
 * place rather than in a dialog: the row already says which account it is, and
 * a dialog would move that question away from its answer.
 */
/**
 * Which project this account's material is filed under.
 *
 * Not cosmetic: context search is per project, so an unfiled account syncs
 * into a scope nothing reads. The row says that outright rather than leaving
 * the user to wonder why a synced mailbox answers nothing.
 */
function AccountProjectSelect({
  account,
  disabled,
  projects,
  onSetProject,
}: {
  account: ConnectorsOverview["accounts"][number];
  disabled: boolean;
  projects: readonly ProjectOption[];
  onSetProject: (accountId: string, projectId: string | null) => void;
}) {
  const items = [
    { label: "No project", value: UNFILED },
    ...projects.map((project) => ({ label: project.title, value: project.id })),
  ];
  return (
    <Select
      disabled={disabled}
      items={items}
      onValueChange={(next: string | null) => {
        if (next === null) return;
        onSetProject(account.id, next === UNFILED ? null : next);
      }}
      value={account.projectId ?? UNFILED}
    >
      <SelectTrigger aria-label={`Project for ${account.displayName}`} size="xs" variant="ghost">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

/** Sentinel for the "no project" option: a Select value cannot be null. */
const UNFILED = "__unfiled__";

export function ConnectorAccountRow({
  account,
  projects,
  state,
  onSync,
  onSetProject,
  onDisconnect,
}: {
  account: ConnectorsOverview["accounts"][number];
  projects: readonly ProjectOption[];
  state: ConnectorActionState;
  onSync: (accountId: string) => void;
  onSetProject: (accountId: string, projectId: string | null) => void;
  onDisconnect: (accountId: string) => void;
}) {
  const [isConfirming, setIsConfirming] = useState(false);
  const status = statusPresentation(account.status);
  const scope = accountScope(account.id);
  const isPending = state.pendingScope === scope;
  const notice = noticeFor(state, scope);

  return (
    <div className="flex flex-col gap-1.5 py-2.5">
      <div className={ROW_GRID}>
        <span className={cn("flex min-w-0 items-baseline gap-2", ACCOUNT_INDENT)}>
          <span className="truncate text-sm text-muted-foreground">{account.displayName}</span>
          <span className="shrink-0 text-xs text-muted-foreground/70">
            {formatLastSynced(account.lastSyncedAt)}
          </span>
        </span>
        <span className={STATUS_CELL}>
          {account.status === "connected" ? (
            <CheckIcon aria-label={status.label} className="size-4 text-success-foreground" />
          ) : (
            <AlertTriangleIcon
              aria-label={status.label}
              className={cn(
                "size-4",
                account.status === "revoked" ? "text-destructive-foreground" : "text-warning",
              )}
            />
          )}
        </span>
        <span className={ACTION_CELL}>
          <AccountProjectSelect
            account={account}
            disabled={isPending}
            onSetProject={onSetProject}
            projects={projects}
          />
          <Button
            aria-label={`Sync ${account.displayName}`}
            disabled={isPending}
            onClick={() => onSync(account.id)}
            size="xs"
            variant="ghost-muted"
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
        </span>
      </div>

      {status.recovery === null ? null : (
        <p className={cn("text-xs text-muted-foreground", ACCOUNT_INDENT)}>{status.recovery}</p>
      )}
      {account.projectId === null ? (
        <p className={cn("text-xs text-muted-foreground", ACCOUNT_INDENT)}>
          Not filed under a project, so this account&apos;s material does not answer any
          project&apos;s context search. Filing it applies from the next sync.
        </p>
      ) : null}
      {showsDetail(account) ? (
        <p className={cn("break-words text-xs text-muted-foreground", ACCOUNT_INDENT)}>
          {account.detail}
        </p>
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

/** The only field on the page, and only where it is the thing standing in the way. */
function ClientIdField({
  overview,
  state,
  onSave,
}: {
  overview: ConnectorsOverview;
  state: ConnectorActionState;
  onSave: (value: string) => void;
}) {
  const [draft, setDraft] = useState("");
  const intent = clientIdSaveIntent(draft, overview.google);
  const isSaving = state.pendingScope === CLIENT_ID_SCOPE;
  const notice = noticeFor(state, CLIENT_ID_SCOPE);

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          aria-label="Google client id"
          autoComplete="off"
          className="sm:flex-1"
          disabled={isSaving}
          onChange={(event) => setDraft(event.currentTarget.value)}
          placeholder="000000000000-xxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com"
          spellCheck={false}
          value={draft}
        />
        <Button
          className="sm:self-start"
          disabled={intent === "unchanged" || isSaving}
          onClick={() => {
            onSave(draft);
            setDraft("");
          }}
          size="sm"
          variant={intent === "clear" ? "destructive-outline" : "outline"}
        >
          {isSaving ? <Spinner className="size-3.5" /> : null}
          {intent === "clear" ? "Use the built-in app" : "Save"}
        </Button>
      </div>
      {notice === null ? null : <NoticeLine notice={notice} />}
    </div>
  );
}

/**
 * Everything the page has to say about the OAuth client id, in one line at the
 * bottom.
 *
 * A release build carries its own, so for almost everyone this is a footnote
 * they never open. A fork, a Workspace org that only allows apps it approved,
 * or a source checkout with no id at all opens it and pastes one — that case
 * is a sentence and a field, not a section of the page.
 */
export function GoogleProjectFooter({
  overview,
  state,
  onSave,
}: {
  overview: ConnectorsOverview;
  state: ConnectorActionState;
  onSave: (value: string) => void;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const missing = needsGoogleSetup(overview.google);

  return (
    <div className="flex flex-col gap-2 pt-1">
      <p className="text-xs text-muted-foreground" id={CLIENT_ID_NOTE_ID}>
        {missing
          ? "This build ships no Google client id, so Google sign-in is off."
          : `${clientIdHintLabel(overview.google)}.`}{" "}
        <button
          className="underline-offset-2 hover:text-foreground hover:underline"
          onClick={() => setIsOpen(!isOpen)}
          type="button"
        >
          {isOpen ? "Never mind" : missing ? "Add one" : "Use your own Google project"}
        </button>
      </p>
      {isOpen ? (
        <div className="flex flex-col gap-1.5">
          <p className="text-xs text-muted-foreground">
            Create an OAuth client of type “Desktop app” in your Google Cloud project and paste its
            id. It is stored on this environment, never in the browser.
          </p>
          <ClientIdField onSave={onSave} overview={overview} state={state} />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The one blocker nobody at a remote browser can clear from where they are
 * standing, said once above the list instead of three times inside it.
 */
export function RemoteOAuthNotice() {
  return (
    <p className="flex items-start gap-2 text-xs text-muted-foreground">
      <MonitorOffIcon className="mt-px size-3.5 shrink-0" />
      <span id={REMOTE_HINT_ID}>
        Google sends you back to a loopback address on this environment's machine, so sign-in has to
        be started there. Syncing and disconnecting work from here.
      </span>
    </p>
  );
}

function ConnectorsSkeleton() {
  return (
    <div className="flex flex-col gap-3">
      <Skeleton className="h-8 w-full rounded-lg" />
      <Skeleton className="h-8 w-full rounded-lg" />
      <Skeleton className="h-8 w-full rounded-lg" />
    </div>
  );
}

/** The whole page's content: one list, connectors with their accounts under them. */
export function ConnectorList({
  overview,
  projects,
  state,
  onConnect,
  onSync,
  onSetProject,
  onDisconnect,
}: {
  overview: ConnectorsOverview;
  projects: readonly ProjectOption[];
  state: ConnectorActionState;
  onConnect: (kind: ConnectorKind) => void;
  onSync: (accountId: string) => void;
  onSetProject: (accountId: string, projectId: string | null) => void;
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

  return (
    <div className="flex flex-col">
      {orphanNotice === null ? null : (
        <div className="pb-2">
          <NoticeLine notice={orphanNotice} />
        </div>
      )}
      <div className={cn(ROW_GRID, "pb-1.5 text-xs text-muted-foreground")}>
        <span>Connector</span>
        <span className={STATUS_CELL}>Status</span>
        <span />
      </div>
      <div className="flex flex-col divide-y divide-border border-t border-border">
        {CONNECTOR_KIND_ORDER.map((kind) => (
          <div className="flex flex-col divide-y divide-border/60" key={kind}>
            <ConnectorRow kind={kind} onConnect={onConnect} overview={overview} state={state} />
            {accountsOfKind(overview.accounts, kind).map((account) => (
              <ConnectorAccountRow
                account={account}
                key={account.id}
                onDisconnect={onDisconnect}
                onSetProject={onSetProject}
                onSync={onSync}
                projects={projects}
                state={state}
              />
            ))}
          </div>
        ))}
      </div>
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

  // The picker's options. A failed read leaves it with "No project" only,
  // which is honest: nothing can be filed while projects are unreadable.
  const loadProjects = useCallback(() => port.listProjects(), [port]);
  const { data: projectList } = usePortData(loadProjects);
  const projects = projectList ?? [];

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
          ? "Back to the built-in Google app."
          : "Client id saved. Connect an account.";
      });
    },
    [port, run],
  );

  const handleConnect = useCallback(
    (kind: ConnectorKind) => {
      if (overview === null) return;
      run(connectScope(kind), async () => {
        const url = authorizationUrlToOpen(await port.connectConnector(kind));
        // Every kind goes through Google, so a missing sign-in link is a broken
        // response rather than a quiet success.
        if (url === null) throw new Error("The server did not return a sign-in link to open.");
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

  const handleSetProject = useCallback(
    (accountId: string, projectId: string | null) => {
      run(accountScope(accountId), async () => {
        await port.setConnectorProject(accountId, projectId);
        await reload();
        return projectId === null
          ? "Detached. Its material stops entering any project on the next sync."
          : "Filed. Its material enters that project from the next sync.";
      });
    },
    [port, reload, run],
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
    <div className="flex flex-col gap-4">
      {port.isFixture ? (
        // Without this the page would claim accounts are connected on a client
        // that has no environment to connect them to.
        <p className="text-xs text-muted-foreground">
          Sample data. Pair an environment to connect your own accounts.
        </p>
      ) : null}

      {overview === null ? (
        <ConnectorsSkeleton />
      ) : (
        <>
          {overview.canStartLocalOAuth ? null : <RemoteOAuthNotice />}

          <ConnectorList
            onConnect={handleConnect}
            onDisconnect={handleDisconnect}
            onSetProject={handleSetProject}
            onSync={handleSync}
            overview={overview}
            projects={projects}
            state={state}
          />

          <GoogleProjectFooter onSave={handleSaveClientId} overview={overview} state={state} />
        </>
      )}
    </div>
  );
}
