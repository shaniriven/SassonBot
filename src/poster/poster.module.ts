import { Module } from '@nestjs/common';
import { PosterService } from './poster.service';
import { BackgroundService } from './background.service';
import { FontService } from './font.service';

@Module({
  providers: [PosterService, BackgroundService, FontService],
  exports: [PosterService, BackgroundService, FontService],
})
export class PosterModule {}
