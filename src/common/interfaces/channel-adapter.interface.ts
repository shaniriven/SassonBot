export type MessageHandler = (userId: string, text: string) => Promise<void>;
export type CommandHandler = (userId: string) => Promise<void>;
export type GuardHandler = (
  userId: string,
  command: string | null,
) => Promise<string | null>;

export interface ChannelAdapter {
  sendMessage(userId: string, text: string): Promise<void>;
  sendImage(userId: string, imageUrl: string, caption?: string): Promise<void>;
  sendAction(
    userId: string,
    action: 'typing' | 'uploading_photo',
  ): Promise<void>;
  onMessage(handler: MessageHandler): void;
  onCommand(command: string, handler: CommandHandler): void;
  useGuard(handler: GuardHandler): void;
  setUserCommands(userId: string, isAdmin: boolean): Promise<void>;
}
