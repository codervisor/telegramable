export interface IMMessage {
  channelId: string;
  chatId: string;
  userId?: string;
  text: string;
  messageId?: number;
  threadId?: number;
  fileId?: string;
  fileName?: string;
  mimeType?: string;
  callbackData?: string;
  callbackQueryId?: string;
  /** Text of the message being replied to (quoted message context). */
  replyToText?: string;
  raw?: unknown;
}

export interface CallbackQuery {
  chatId: string;
  userId?: string;
  messageId?: number;
  data: string;
  callbackQueryId: string;
}

export interface IMAdapterStartOptions {
  /** When true, registers handlers but skips transport-level polling. */
  polling?: boolean;
}

export interface IMAdapter {
  id: string;
  start: (onMessage: (message: IMMessage) => void, options?: IMAdapterStartOptions) => Promise<void>;
  sendMessage: (chatId: string, text: string) => Promise<void>;
  stop: () => Promise<void>;

  // Rich features (optional — adapters that don't support them leave them undefined)
  sendMessageWithMarkup?: (chatId: string, text: string, markup: unknown, options?: { threadId?: number }) => Promise<number>;
  editMessage?: (chatId: string, messageId: number, text: string) => Promise<void>;
  editMessageWithMarkup?: (chatId: string, messageId: number, text: string, markup: unknown) => Promise<void>;
  deleteMessage?: (chatId: string, messageId: number) => Promise<void>;
  answerCallbackQuery?: (callbackQueryId: string, text?: string) => Promise<void>;
  sendDocument?: (chatId: string, file: Buffer | string, options?: { caption?: string; fileName?: string; threadId?: number }) => Promise<void>;
  getFileUrl?: (fileId: string) => Promise<string>;
  createForumTopic?: (chatId: string, name: string) => Promise<number>;
  closeForumTopic?: (chatId: string, topicId: number) => Promise<void>;
  sendChatAction?: (chatId: string, action: string, options?: { threadId?: number }) => Promise<void>;
  setMessageReaction?: (chatId: string, messageId: number, emoji: string | null) => Promise<void>;
}
