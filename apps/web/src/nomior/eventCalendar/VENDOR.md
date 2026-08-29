# Vendored: ReUI Event Calendar

Everything in this directory except `icons.tsx` is third-party source, copied
verbatim from a registry and not written here.

- **Source**: `https://reui.io/r/event-calendar.json` (ReUI, keenthemes/reui)
- **License**: MIT
- **Vendored**: 2026-08-29

## Why it is vendored rather than depended on

ReUI ships this as shadcn-registry source, not as an npm package: copying it in
_is_ the supported way to consume it. It is also the only event calendar we
found that is MIT, built on Base UI rather than Radix, and styled with Tailwind
tokens instead of its own stylesheet — the three things that decide whether a
calendar looks like the rest of this app or like a widget dropped into it.

## What was changed

Nothing inside the files but their import paths, applied mechanically:

- `@/components/reui/event-calendar/*` → `./*`
- `@/components/ui/*` → `./ui/*`, a directory of one-line re-exports. The
  source expects shadcn's export names (`TooltipContent`, `PopoverContent`);
  this app's are Base UI's (`TooltipPopup`, `PopoverPopup`). Same components,
  so the shims are renames, and they live outside the vendored files so those
  stay verbatim.
- `@/lib/utils` → `../../lib/utils`
- `@/app/(create)/components/icon-placeholder`, `@/components/reui/icon-stack`
  → `./icons` (see `icons.tsx`)
- the leading `"use client"` directive, which this app has no use for

Each file also gains two suppression lines it did not ship with — `@ts-nocheck`
and `eslint-disable`. This repo's tsconfig is stricter than the one the source
is written against (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
and its lint rules are its own; fixing 83 type errors and a page of warnings by
hand would be work thrown away on the next update, and every one of them is
inside code nobody here maintains. Exported types still check at every call
site outside this directory, which is where our own mistakes would be.

`event-calendar-nav.tsx` is deliberately absent. It is a leaf — nothing else in
the set imports it — and it was the only file needing a date-picker and a
dropdown-menu component this app does not have. `CalendarPanel` brings its own
header.

## Updating

Re-fetch the registry item and re-apply the rewrites above; do not hand-edit
these files, or the next update silently drops the edit. If a change is
genuinely needed, wrap it from the outside — the component takes `renderEvent`,
`components` and `classNames` overrides for exactly that.
