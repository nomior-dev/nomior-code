import { SearchIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { Badge } from "../components/ui/badge";
import { Card, CardPanel } from "../components/ui/card";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../components/ui/input-group";
import { Skeleton } from "../components/ui/skeleton";
import { formatSourceDate, sourceKindLabel } from "./contextMemory.logic";
import { fixtureNomiorPort } from "./fixtures";
import { useNomiorPort } from "./port";
import { PortErrorState } from "./PortErrorState";
import type { ContextSnippet } from "./types";

const SEARCH_DEBOUNCE_MS = 250;

function SnippetCard({ snippet }: { snippet: ContextSnippet }) {
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
      </CardPanel>
    </Card>
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

  return (
    <section aria-label="Context search" className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-medium">Search context</h2>
        <p className="text-sm text-muted-foreground">
          Meetings, documents, reviews and memories, answered with cited evidence.
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
            <SnippetCard key={snippet.id} snippet={snippet} />
          ))}
        </div>
      )}
    </section>
  );
}
