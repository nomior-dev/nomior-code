export function Footer() {
  return (
    <footer className="border-t border-line py-12">
      <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-3 px-5 md:flex-row md:items-center md:px-8">
        <p className="flex items-center gap-2 text-sm font-medium tracking-tight">
          Nomior
          <span className="text-fog">Code</span>
          <span aria-hidden className="size-1.5 rounded-full bg-gold" />
        </p>
        <p className="font-mono text-xs text-fog-dim md:ms-auto">
          Part of the{" "}
          <a className="text-fog transition-colors hover:text-cream" href="https://nomior.com">
            Nomior
          </a>{" "}
          family · © 2026 Nomior
        </p>
      </div>
    </footer>
  );
}
