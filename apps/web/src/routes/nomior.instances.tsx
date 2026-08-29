import { createFileRoute, redirect } from "@tanstack/react-router";

/**
 * Instances moved to `/settings/instances`. The old path is kept as a redirect
 * because it shipped: a bookmark, a deep link from a thread, or a stale client
 * still resolves rather than landing on a 404.
 */
export const Route = createFileRoute("/nomior/instances")({
  beforeLoad: () => {
    throw redirect({ to: "/settings/instances", replace: true });
  },
});
