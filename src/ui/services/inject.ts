/**
 * POST /api/inject logic, kept free of Bun.serve so it can be unit-tested.
 *
 * Two behaviours beyond the original handler:
 *  - `forward` request field (default `true`). When strictly `false`, the reply is not
 *    forwarded to Telegram. Machine callers such as the Paperclip claudeclaw_gateway
 *    adapter use this so their wake turns are not echoed to the human's chat.
 *  - `sessionId` response field: the main session id, or `null` if unavailable.
 *  - `thread` request field (optional). When set, the turn runs in that thread's queue
 *    and session (the same `tg:<chatId>:<topicId>` keys the Telegram handler uses) instead
 *    of the global session, and `sessionId` is that thread's session id.
 */

export interface InjectRequest {
  message: string;
  /** Forward the reply to the first allowed Telegram user. Defaults to true. */
  forward: boolean;
  /** Thread/session key to run in. Absent means the global session. */
  thread?: string;
}

export interface InjectResponse {
  ok: true;
  result: string;
  exitCode: number;
  sessionId: string | null;
}

export interface InjectDeps {
  run: (message: string, thread?: string) => Promise<{ stdout: string; exitCode: number }>;
  peekSession: () => Promise<{ sessionId?: string } | null>;
  peekThreadSession: (thread: string) => Promise<{ sessionId?: string } | null>;
  telegram: { token: string; allowedUserIds: number[] };
  /** Overridable for tests; defaults to the Telegram Bot API sendMessage call. */
  sendTelegram?: (token: string, chatId: number, text: string) => Promise<unknown>;
}

/** Returns null when the body carries no usable message. */
export function parseInjectBody(body: unknown): InjectRequest | null {
  const raw = (body ?? {}) as Record<string, unknown>;
  const message = typeof raw.message === "string" ? raw.message.trim() : "";
  if (!message) return null;
  // Only a strict boolean `false` disables forwarding; every existing caller
  // (which never sends the field) keeps the original behaviour.
  const forward = raw.forward !== false;
  // Optional thread key; blank or non-string values mean the global session, as before.
  const thread = typeof raw.thread === "string" ? raw.thread.trim() : "";
  return thread ? { message, forward, thread } : { message, forward };
}

export function sendTelegramMessage(token: string, chatId: number, text: string): Promise<unknown> {
  return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

export async function handleInject(req: InjectRequest, deps: InjectDeps): Promise<InjectResponse> {
  const result = await deps.run(req.message, req.thread);
  const text = result.stdout.trim();
  const { telegram } = deps;
  if (req.forward && text && telegram.token && telegram.allowedUserIds.length > 0) {
    const send = deps.sendTelegram ?? sendTelegramMessage;
    // Fire-and-forget, as before: a Telegram failure must not fail the inject call.
    send(telegram.token, telegram.allowedUserIds[0], text).catch(() => {});
  }
  // Report the session id the turn ran in (the thread's row in sessions.json, or the
  // main session.json) so callers can persist it without reading either file.
  const peek = req.thread ? deps.peekThreadSession(req.thread) : deps.peekSession();
  const session = await peek.catch(() => null);
  return {
    ok: true,
    result: result.stdout,
    exitCode: result.exitCode,
    sessionId: session?.sessionId ?? null,
  };
}
