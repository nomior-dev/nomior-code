const NIGHTLY_SERVER_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/;

/**
 * Splits a base name into the brand lockup's two halves: the name carries the
 * emphasis, the trailing product word is set muted beside it ("Nomior" +
 * "Code"). A single-word base name has no muted half.
 */
export function splitBrandLockup(baseName: string): {
  readonly name: string;
  readonly product: string | null;
} {
  const trimmed = baseName.trim();
  const lastSpace = trimmed.lastIndexOf(" ");
  return lastSpace === -1
    ? { name: trimmed, product: null }
    : { name: trimmed.slice(0, lastSpace), product: trimmed.slice(lastSpace + 1) };
}

export function formatAppDisplayName(input: {
  readonly baseName: string;
  readonly stageLabel: string;
}): string {
  if (input.stageLabel.trim().toLowerCase() === "latest") {
    return input.baseName;
  }

  return `${input.baseName} (${input.stageLabel})`;
}

export function resolveServerBackedAppStageLabel(input: {
  readonly primaryServerVersion: string | null | undefined;
  readonly fallbackStageLabel: string;
}): string {
  return input.primaryServerVersion &&
    NIGHTLY_SERVER_VERSION_PATTERN.test(input.primaryServerVersion)
    ? "Nightly"
    : input.fallbackStageLabel;
}

export function resolveServerBackedAppDisplayName(input: {
  readonly baseName: string;
  readonly fallbackDisplayName: string;
  readonly fallbackStageLabel: string;
  readonly primaryServerVersion: string | null | undefined;
}): string {
  const stageLabel = resolveServerBackedAppStageLabel({
    primaryServerVersion: input.primaryServerVersion,
    fallbackStageLabel: input.fallbackStageLabel,
  });

  return stageLabel === input.fallbackStageLabel
    ? input.fallbackDisplayName
    : formatAppDisplayName({ baseName: input.baseName, stageLabel });
}
