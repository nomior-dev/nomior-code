import { ArrowUpRightIcon, CheckIcon, SearchIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { formatRelativeTimeLabel } from "../timestampFormat";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardPanel } from "../components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import { Separator } from "../components/ui/separator";
import { Skeleton } from "../components/ui/skeleton";
import {
  formatSourceDate,
  orderMemoryCandidates,
  pendingCandidateCount,
  sourceKindLabel,
} from "./contextMemory.logic";
import { fixtureNomiorPort } from "./fixtures";
import { useNomiorPort } from "./port";
import { PortErrorState } from "./PortErrorState";
import type { ContextSnippet, MemoryCandidate, MemoryCandidateResolution } from "./types";
import { usePortData } from "./usePortData";

const SEARCH_DEBOUNCE_MS = 250;

function SnippetCard({
  snippet,
  onOpenSource,
}: {
  snippet: ContextSnippet;
  onOpenSource: (snippetId: string) => void;
}) {
  return (
    <Card>
      <CardPanel className="flex flex-col gap-2 p-4">
        <div className="flex min-w-0 items-center gap-2">
          <Badge size="sm" variant="secondary">
            {sourceKindLabel(snippet.sourceKind)}
          </Badge>
          <span className="truncate text-sm font-medium">{snippet.sourceTitle}</span>
          <span className="ms-auto shrink-0 text-xs text-muted-foreground">
            {formatSourceDate(snippet.sourceDate)}
          </span>
        </div>
        <blockquote className="border-l-2 border-border pl-3 text-sm text-muted-foreground">
          {snippet.excerpt}
        </blockquote>
        <div>
          <Button onClick={() => onOpenSource(snippet.id)} size="xs" variant="ghost-muted">
            <ArrowUpRightIcon className="size-3.5" />
            Open source
          </Button>
        </div>
      </CardPanel>
    </Card>
  );
}

export function MemoryCandidateRow({
  candidate,
  onResolve,
}: {
  candidate: MemoryCandidate;
  onResolve: (id: string, resolution: MemoryCandidateResolution) => void;
}) {
  return (
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-start sm:gap-4">
      <div className="min-w-0 flex-1">
        <p className="text-sm">{candidate.text}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {candidate.source} · {formatRelativeTimeLabel(candidate.capturedAt)}
        </p>
      </div>
      {candidate.status === "pending" ? (
        <div className="flex shrink-0 items-center gap-1.5">
          <Button onClick={() => onResolve(candidate.id, "approved")} size="xs" variant="outline">
            <CheckIcon className="size-3.5" />
            Approve
          </Button>
          <Button
            onClick={() => onResolve(candidate.id, "rejected")}
            size="xs"
            variant="ghost-muted"
          >
            <XIcon className="size-3.5" />
            Reject
          </Button>
        </div>
      ) : (
        <Badge size="sm" variant={candidate.status === "approved" ? "success" : "secondary"}>
          {candidate.status === "approved" ? "Approved" : "Rejected"}
        </Badge>
      )}
    </div>
  );
}

export function ContextMemoryPanel() {
  const port = useNomiorPort(fixtureNomiorPort);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<readonly ContextSnippet[] | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<Error | null>(null);
  // Bumped by the error state's Retry button to rerun the same query.
  const [searchGeneration, setSearchGeneration] = useState(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length === 0) {
      setResults(null);
      setIsSearching(false);
      setSearchError(null);
      return;
    }
    setIsSearching(true);
    setSearchError(null);
    let cancelled = false;
    const timer = setTimeout(() => {
      port.searchContext(trimmed).then(
        (snippets) => {
          if (cancelled) return;
          setResults(snippets);
          setIsSearching(false);
        },
        (cause: unknown) => {
          if (cancelled) return;
          setSearchError(cause instanceof Error ? cause : new Error(String(cause)));
          setIsSearching(false);
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [port, query, searchGeneration]);

  const retrySearch = useCallback(() => setSearchGeneration((value) => value + 1), []);

  const loadCandidates = useCallback(() => port.listMemoryCandidates(), [port]);
  const {
    data: candidates,
    error: candidatesError,
    reload: reloadCandidates,
  } = usePortData(loadCandidates);

  const handleOpenSource = useCallback(
    (snippetId: string) => {
      void port.openContextSource(snippetId);
    },
    [port],
  );
  const handleResolve = useCallback(
    (id: string, resolution: MemoryCandidateResolution) => {
      void port.resolveMemoryCandidate(id, resolution).then(reloadCandidates);
    },
    [port, reloadCandidates],
  );

  const pendingCount = candidates === null ? null : pendingCandidateCount(candidates);

  return (
    <div className="flex flex-col gap-8">
      <section aria-label="Context search" className="flex flex-col gap-3">
        <div>
          <h2 className="text-sm font-medium">Search context</h2>
          <p className="text-sm text-muted-foreground">
            Meetings, documents, threads and reviews, answered with cited evidence.
          </p>
        </div>
        <InputGroup>
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            aria-label="Search context"
            onChange={(event) => setQuery(event.currentTarget.value)}
            placeholder="Search your project's context..."
            type="search"
            value={query}
          />
        </InputGroup>
        {isSearching ? (
          <div className="flex flex-col gap-2">
            <Skeleton className="h-24 w-full rounded-2xl" />
            <Skeleton className="h-24 w-full rounded-2xl" />
          </div>
        ) : searchError !== null ? (
          <PortErrorState label="Search failed." onRetry={retrySearch} />
        ) : results === null ? null : results.length === 0 ? (
          <p className="text-sm text-muted-foreground">No matches. Try fewer or different words.</p>
        ) : (
          <div className="flex flex-col gap-2">
            {results.map((snippet) => (
              <SnippetCard key={snippet.id} onOpenSource={handleOpenSource} snippet={snippet} />
            ))}
          </div>
        )}
      </section>

      <Separator />

      <section aria-label="Memory candidates" className="flex flex-col gap-1">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">Memory candidates</h2>
          {pendingCount !== null && pendingCount > 0 ? (
            <Badge size="sm" variant="info">
              {pendingCount} pending
            </Badge>
          ) : null}
        </div>
        <p className="text-sm text-muted-foreground">
          Facts extracted from reviews and meetings. Nothing is promoted to memory without your
          approval.
        </p>
        {candidatesError !== null ? (
          <div className="mt-3">
            <PortErrorState label="Couldn't load memory candidates." onRetry={reloadCandidates} />
          </div>
        ) : candidates === null ? (
          <div className="mt-3 flex flex-col gap-2">
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
          </div>
        ) : candidates.length === 0 ? (
          <p className="mt-3 text-sm text-muted-foreground">
            No candidates yet. Findings from reviews and meeting decisions land here first.
          </p>
        ) : (
          <div className="mt-1 flex flex-col divide-y divide-border">
            {orderMemoryCandidates(candidates).map((candidate) => (
              <MemoryCandidateRow
                candidate={candidate}
                key={candidate.id}
                onResolve={handleResolve}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
