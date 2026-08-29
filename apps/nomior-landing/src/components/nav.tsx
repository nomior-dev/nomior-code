export function Nav() {
  return (
    <header className="fixed inset-x-0 top-0 z-40">
      <nav
        aria-label="Main"
        className="mx-auto flex h-16 w-full max-w-[1100px] items-center gap-6 px-5 md:px-8"
      >
        <a className="flex items-center gap-2 text-sm font-medium tracking-tight" href="#top">
          Nomior
          <span className="text-fog">Code</span>
          <span aria-hidden className="size-1.5 rounded-full bg-gold" />
        </a>
        <div className="ms-auto flex items-center gap-5 font-mono text-xs text-fog">
          <a className="transition-colors hover:text-cream" href="#loop">
            Loop
          </a>
          <a className="transition-colors hover:text-cream" href="#features">
            Features
          </a>
          <a className="transition-colors hover:text-cream" href="#pricing">
            Pricing
          </a>
        </div>
      </nav>
    </header>
  );
}
