/**
 * Handlers for the meetings RPC methods.
 *
 * Same shape as `panelHandlers.ts`: plain functions taking their service, so a
 * test can drive them against a real store without building a layer graph.
 * `MeetingStore` already returns the panel's shapes, so the only work here is
 * turning its typed failures into the one wire error and answering honestly
 * about whether retrying can help.
 *
 * @module nomior/rpc/meetingHandlers
 */
import {
  NomiorRequestError,
  type NomiorMeetingDetail,
  type NomiorMeetingsListResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type { MeetingStore } from "../meetings/MeetingStore.ts";

const failed = (fallback: string, retryable: boolean) => (cause: unknown) =>
  new NomiorRequestError({
    message: cause instanceof Error && cause.message.length > 0 ? cause.message : fallback,
    retryable,
  });

export const listMeetings = Effect.fn("nomior.rpc.listMeetings")(function* (
  store: MeetingStore["Service"],
  input: { readonly rangeStart?: string | undefined; readonly rangeEnd?: string | undefined },
): Effect.fn.Return<NomiorMeetingsListResult, NomiorRequestError> {
  const meetings = yield* store
    .listMeetings(input)
    .pipe(Effect.mapError(failed("Meetings are unavailable.", true)));
  return { meetings };
});

export const getMeeting = Effect.fn("nomior.rpc.getMeeting")(function* (
  store: MeetingStore["Service"],
  input: { readonly meetingId: string },
): Effect.fn.Return<NomiorMeetingDetail, NomiorRequestError> {
  return yield* store.getMeeting(input.meetingId).pipe(
    Effect.mapError((cause) =>
      cause._tag === "NomiorMeetingNotFoundError"
        ? // A meeting id that resolves to nothing resolves to nothing next time.
          new NomiorRequestError({
            message: `No meeting with id ${input.meetingId}.`,
            retryable: false,
          })
        : failed("This meeting is unavailable.", true)(cause),
    ),
  );
});
