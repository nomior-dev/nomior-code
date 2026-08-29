import { PinIcon, PinOffIcon } from "lucide-react";
import { useCallback } from "react";

import { formatRelativeTimeLabel } from "../timestampFormat";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardPanel } from "../components/ui/card";
import { Label } from "../components/ui/label";
import { Skeleton } from "../components/ui/skeleton";
import { Switch } from "../components/ui/switch";
import { fixtureNomiorPort } from "./fixtures";
import { canPin, describeDecision, formatHeadroom, healthPresentation } from "./instances.logic";
import { useNomiorPort } from "./port";
import { PortErrorState } from "./PortErrorState";
import type { ProviderInstanceItem } from "./types";
import { usePortData } from "./usePortData";

export function InstanceRow({
  instance,
  onTogglePin,
}: {
  instance: ProviderInstanceItem;
  onTogglePin: (id: string, pinned: boolean) => void;
}) {
  const health = healthPresentation(instance.health);
  const pinnable = canPin(instance);
  return (
    <div className="flex min-w-0 items-center gap-3 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-medium">{instance.label}</span>
          <Badge size="sm" variant={health.tone}>
            {health.label}
          </Badge>
          {instance.pinned ? (
            <Badge size="sm" variant="info">
              Pinned
            </Badge>
          ) : null}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {instance.provider} · {formatHeadroom(instance.headroom)}
        </p>
      </div>
      <Button
        disabled={!pinnable}
        onClick={() => onTogglePin(instance.id, !instance.pinned)}
        size="xs"
        variant={instance.pinned ? "secondary" : "outline"}
      >
        {instance.pinned ? (
          <>
            <PinOffIcon className="size-3.5" />
            Unpin
          </>
        ) : (
          <>
            <PinIcon className="size-3.5" />
            Pin
          </>
        )}
      </Button>
    </div>
  );
}

export function InstancesPanel() {
  const port = useNomiorPort(fixtureNomiorPort);

  const loadInstances = useCallback(() => port.listInstances(), [port]);
  const {
    data: instances,
    error: instancesError,
    reload: reloadInstances,
  } = usePortData(loadInstances);
  const loadScheduler = useCallback(() => port.getSchedulerState(), [port]);
  const {
    data: scheduler,
    error: schedulerError,
    reload: reloadScheduler,
  } = usePortData(loadScheduler);

  const handleTogglePin = useCallback(
    (id: string, pinned: boolean) => {
      void port.setInstancePinned(id, pinned).then(() => {
        reloadInstances();
        reloadScheduler();
      });
    },
    [port, reloadInstances, reloadScheduler],
  );
  const handleAdvisoryModeChange = useCallback(
    (enabled: boolean) => {
      void port.setAdvisoryMode(enabled).then(reloadScheduler);
    },
    [port, reloadScheduler],
  );

  const decision =
    scheduler === null || instances === null
      ? null
      : describeDecision(scheduler.lastDecision, instances);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardPanel className="flex flex-col gap-3 p-4">
          <div>
            <h2 className="text-sm font-medium">Scheduler</h2>
            {schedulerError !== null ? (
              <div className="mt-2">
                <PortErrorState label="Couldn't load scheduler state." onRetry={reloadScheduler} />
              </div>
            ) : scheduler === null ? (
              <Skeleton className="mt-2 h-10 w-full rounded" />
            ) : decision === null ? (
              <p className="mt-1 text-sm text-muted-foreground">
                No decision yet. The first new thread will pick an instance and explain why here.
              </p>
            ) : (
              <p className="mt-1 text-sm text-muted-foreground">
                Picked <span className="font-medium text-foreground">{decision.instanceLabel}</span>
                {scheduler.lastDecision ? (
                  <span> · {formatRelativeTimeLabel(scheduler.lastDecision.decidedAt)}</span>
                ) : null}
                <br />
                {decision.reason}
              </p>
            )}
          </div>
          <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
            <div>
              <Label htmlFor="nomior-advisory-mode">Advisory mode</Label>
              <p className="text-xs text-muted-foreground">
                Suggest an instance for each new thread instead of switching automatically.
              </p>
            </div>
            <Switch
              checked={scheduler?.advisoryMode ?? true}
              disabled={scheduler === null}
              id="nomior-advisory-mode"
              onCheckedChange={handleAdvisoryModeChange}
            />
          </div>
        </CardPanel>
      </Card>

      <section aria-label="Provider instances" className="flex flex-col gap-1">
        <h2 className="text-sm font-medium">Instances</h2>
        <p className="text-sm text-muted-foreground">
          Connected provider profiles. Pin one to route every new thread to it; headroom comes from
          each provider's own rate-limit events, never from credentials.
        </p>
        {instancesError !== null ? (
          <div className="mt-3">
            <PortErrorState label="Couldn't load instances." onRetry={reloadInstances} />
          </div>
        ) : instances === null ? (
          <div className="mt-3 flex flex-col gap-2">
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
          </div>
        ) : (
          <div className="mt-1 flex flex-col divide-y divide-border">
            {instances.map((instance) => (
              <InstanceRow instance={instance} key={instance.id} onTogglePin={handleTogglePin} />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
