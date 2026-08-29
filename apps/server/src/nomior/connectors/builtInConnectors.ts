/**
 * BUILT_IN_CONNECTORS — the static set of `ConnectorDriver`s this build
 * ships with. Mirrors `provider/builtInDrivers.ts`: adding a first-party
 * connector means implementing `ConnectorDriver` in its own directory and
 * appending it here; the aggregated env type is the union every runtime
 * layer must satisfy.
 *
 * @module nomior/connectors/builtInConnectors
 */
import type { AnyConnectorDriver } from "./ConnectorDriver.ts";
import { GmailDriver, type GmailDriverEnv } from "./google/GmailDriver.ts";
import {
  GoogleCalendarDriver,
  type GoogleCalendarDriverEnv,
} from "./google/GoogleCalendarDriver.ts";

export type BuiltInConnectorsEnv = GoogleCalendarDriverEnv | GmailDriverEnv;

/**
 * Ordered list of built-in connector drivers. Order is presentation-only;
 * lookup is by `driverKind`.
 */
export const BUILT_IN_CONNECTORS: ReadonlyArray<AnyConnectorDriver<BuiltInConnectorsEnv>> = [
  GoogleCalendarDriver,
  GmailDriver,
];

export const findConnectorDriver = (
  driverKind: string,
): AnyConnectorDriver<BuiltInConnectorsEnv> | undefined =>
  BUILT_IN_CONNECTORS.find((driver) => driver.driverKind === driverKind);
