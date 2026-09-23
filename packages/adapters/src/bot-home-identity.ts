/** Overlay / facade `_meta` keys. Match Switchboard `dev.switchboard/*`. */

export const META_BOT_ID = "dev.switchboard/bot_id";
export const META_RUN_ID = "dev.switchboard/run_id";
export const META_THREAD_ID = "dev.switchboard/thread_id";
export const META_SPACE_ID = "dev.switchboard/space_id";
export const META_USER_ID = "dev.switchboard/user_id";

export type BotHomeIdentity = {
  botId: string;
  runId: string;
  threadId: string;
  spaceId: string;
  userId: string;
};

export function metaString(meta: Record<string, unknown> | undefined, key: string): string {
  const raw = meta?.[key];
  if (raw === undefined || raw === null) return "";
  return String(raw).trim();
}

export function identityFromMeta(meta: Record<string, unknown> | undefined): BotHomeIdentity {
  return {
    botId: metaString(meta, META_BOT_ID),
    runId: metaString(meta, META_RUN_ID),
    threadId: metaString(meta, META_THREAD_ID),
    spaceId: metaString(meta, META_SPACE_ID),
    userId: metaString(meta, META_USER_ID),
  };
}

export function overlayMeta(identity: {
  botId: string;
  runId: string;
  threadId: string;
  spaceId?: string;
  userId?: string;
}): Record<string, string> {
  const payload: Record<string, string> = {
    [META_BOT_ID]: identity.botId,
    [META_RUN_ID]: identity.runId,
    [META_THREAD_ID]: identity.threadId,
  };
  if (identity.spaceId) payload[META_SPACE_ID] = identity.spaceId;
  if (identity.userId) payload[META_USER_ID] = identity.userId;
  return payload;
}

export class BotHomeIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotHomeIdentityError";
  }
}

export function requireBotId(identity: BotHomeIdentity): string {
  if (!identity.botId) {
    throw new BotHomeIdentityError("bot-home tools require _meta dev.switchboard/bot_id");
  }
  return identity.botId;
}

export function requireParentRun(identity: BotHomeIdentity): string {
  if (!identity.runId) {
    throw new BotHomeIdentityError("attach_file requires parent run identity in _meta");
  }
  return identity.runId;
}
