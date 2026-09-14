/**
 * POST /api/inject logic, kept free of Bun.serve so it can be unit-tested.
 *
 * Two behaviours beyond the original handler:
 *  - `forward` request field (default `true`). When strictly `false`, the reply is not
 *    forwarded to Telegram. Machine callers such as the Paperclip claudeclaw_gateway
 *    adapter use this so their wake turns are not echoed to the human's chat.
 *  - `sessionId` response field: the main session id, or `null` if unavailable.
 */

export interface InjectRequest {
  message: string;
  /** Forward the reply to the first allowed Telegram user. Defaults to true. */
  forward: boolean;
}

export interface InjectResponse {
  ok: true;
  result: string;
  exitCode: number;
  sessionId: string | null;
}

export interface InjectDeps {
  run: (message: string) => Promise<{ stdout: string; exitCode: number }>;
  peekSession: () => Promise<{ sessionId?: string } | null>;
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
  return { message, forward };
}

export function sendTelegramMessage(token: string, chatId: number, text: string): Promise<unknown> {
  return fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

export async function handleInject(req: InjectRequest, deps: InjectDeps): Promise<InjectResponse> {
  const result = await deps.run(req.message);
  const text = result.stdout.trim();
  const { telegram } = deps;
  if (req.forward && text && telegram.token && telegram.allowedUserIds.length > 0) {
    const send = deps.sendTelegram ?? sendTelegramMessage;
    // Fire-and-forget, as before: a Telegram failure must not fail the inject call.
    send(telegram.token, telegram.allowedUserIds[0], text).catch(() => {});
  }
  // Report the main session id so callers can persist it without reading session.json.
  const session = await deps.peekSession().catch(() => null);
  return {
    ok: true,
    result: result.stdout,
    exitCode: result.exitCode,
    sessionId: session?.sessionId ?? null,
  };
}
