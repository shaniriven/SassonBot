export type MessageHandler = (userId: string, text: string) => Promise<void>;
export type CommandHandler = (userId: string) => Promise<void>;
export type GuardHandler = (
  userId: string,
  command: string | null,
) => Promise<string | null>;
export type InlineButton = {
  text: string;
  callbackData: string;
};
export type CallbackQueryHandler = (
  userId: string,
  callbackData: string,
  messageId: number | null,
  answerCallback: (text?: string) => Promise<void>,
) => Promise<void>;

export interface ChannelAdapter {
  sendMessage(userId: string, text: string): Promise<void>;
  sendMessageWithInlineButtons(
    userId: string,
    text: string,
    buttons: InlineButton[][],
  ): Promise<number>;
  removeInlineButtons(userId: string, messageId: number): Promise<void>;
  editMessageText(userId: string, messageId: number, text: string): Promise<void>;
  sendImage(userId: string, imageUrl: string, caption?: string): Promise<void>;
  sendPhoto(userId: string, buffer: Buffer, caption?: string): Promise<string>;
  sendAction(
    userId: string,
    action: 'typing' | 'uploading_photo',
  ): Promise<void>;
  onCallbackQuery(handler: CallbackQueryHandler): void;
  onMessage(handler: MessageHandler): void;
  onCommand(command: string, handler: CommandHandler): void;
  useGuard(handler: GuardHandler): void;
  setUserCommands(userId: string, isAdmin: boolean): Promise<void>;
}
