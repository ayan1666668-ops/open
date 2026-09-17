import { expect, vi } from "vitest";

export const noopAsync = async () => {};

export function createSlackPlatformError(
  error: string,
  details?: { needed?: string; provided?: string },
) {
  // Mirrors @slack/web-api's platformErrorFromResult: message plus structured result data.
  return Object.assign(new Error(`An API error occurred: ${error}`), {
    code: "slack_webapi_platform_error",
    data: { ok: false, error, ...details },
  });
}

export function expectRecordFields(
  record: Record<string, unknown>,
  fields: Record<string, unknown>,
) {
  for (const [key, value] of Object.entries(fields)) {
    expect(record[key]).toEqual(value);
  }
}

export function requireMockCall(mock: unknown, index: number, label: string): unknown[] {
  const call = (mock as { mock?: { calls?: unknown[][] } }).mock?.calls?.[index];
  if (!call) {
    throw new Error(`missing ${label} call ${index + 1}`);
  }
  return call;
}

export function expectMockCallArgFields(
  mock: unknown,
  index: number,
  label: string,
  fields: Record<string, unknown>,
) {
  expectRecordFields(requireMockCall(mock, index, label)[0] as Record<string, unknown>, fields);
}

export function expectStreamText(
  startMock: { mock: { calls: unknown[][] } },
  appendMock: { mock: { calls: unknown[][] } },
  text: string,
  count = 1,
) {
  const matches = [...startMock.mock.calls, ...appendMock.mock.calls].filter(
    ([input]) => (input as { text?: string }).text === text,
  );
  expect(matches).toHaveLength(count);
}

export function createDeliverReplyCallAsserter(mock: unknown, threadTs: string) {
  return (index: number, text: string, fields?: Record<string, unknown>) => {
    const params = requireMockCall(mock, index, "deliver replies")[0] as Record<string, unknown>;
    expectRecordFields(params, { replyThreadTs: threadTs, ...fields });
    expect(params.replies).toEqual([{ text }]);
  };
}

export function planUpdate(title: string) {
  return { type: "plan_update", title };
}

export function taskUpdate(
  id: unknown,
  title: string,
  status: "pending" | "in_progress" | "complete" | "error",
  extra?: Record<string, unknown>,
) {
  return { type: "task_update", id, title, status, ...extra };
}

export function contentTaskId(prefix: string) {
  return expect.stringMatching(new RegExp(`^${prefix}_[a-f0-9]{8}_1$`, "u"));
}

export function createDraftStreamStub() {
  const noop = () => {};
  return {
    update: vi.fn(),
    flush: vi.fn(noopAsync),
    clear: vi.fn(noopAsync),
    discardPending: vi.fn(noopAsync),
    seal: vi.fn(noopAsync),
    stop: vi.fn(noop),
    forceNewMessage: vi.fn(),
    dropDetachedMessages: vi.fn(noopAsync),
    finalizeMessage: vi.fn(async (_messageId: string, editFinal: () => Promise<void>) => {
      await editFinal();
      return true;
    }),
    messageId: (): string | undefined => "171234.567",
    channelId: () => "C123",
  };
}

export function draftUpdateTexts(draftStream: ReturnType<typeof createDraftStreamStub>): string[] {
  return draftStream.update.mock.calls.map(([update]) => {
    if (typeof update === "string") {
      return update;
    }
    return (update as { text: string }).text;
  });
}

export function expectLastDraftUpdateText(
  draftStream: ReturnType<typeof createDraftStreamStub>,
  expected: string,
) {
  expect(draftUpdateTexts(draftStream).at(-1)).toBe(expected);
}
