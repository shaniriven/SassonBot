export type MessageHandler = (userId: string, text: string) => Promise<void>;
export type CommandHandler = (userId: string) => Promise<void>;

export interface ChannelAdapter {
  sendMessage(userId: string, text: string): Promise<void>;
  sendImage(userId: string, imageUrl: string, caption?: string): Promise<void>;
  sendAction(
    userId: string,
    action: 'typing' | 'uploading_photo',
  ): Promise<void>;
  onMessage(handler: MessageHandler): void;
  onCommand(command: string, handler: CommandHandler): void;
}
