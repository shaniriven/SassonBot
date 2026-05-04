import { Global, Module } from '@nestjs/common';
import { TelegramAdapter } from './telegram.adapter';

@Global()
@Module({
  providers: [TelegramAdapter],
  exports: [TelegramAdapter],
})
export class TelegramModule {}
