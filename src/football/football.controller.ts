import { Controller, Get } from '@nestjs/common';
import { FootballService } from './football.service';

@Controller('football')
export class FootballController {
  constructor(private readonly football: FootballService) {}

  @Get('sync')
  async sync() {
    return this.football.manualSync();
  }

  @Get('sync-leagues')
  async syncLeagues() {
    return this.football.syncLeagues();
  }
}
