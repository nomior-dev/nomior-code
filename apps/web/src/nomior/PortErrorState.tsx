import { RefreshCwIcon } from "lucide-react";

import { Button } from "../components/ui/button";

/** Inline failure state for a port read, with a retry affordance. */
export function PortErrorState({ label, onRetry }: { label: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-border py-8">
      <p className="text-sm text-muted-foreground">{label}</p>
      <Button onClick={onRetry} size="xs" variant="outline">
        <RefreshCwIcon className="size-3.5" />
        Retry
      </Button>
    </div>
  );
}
