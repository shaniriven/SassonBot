import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

export interface MatchSelectionItem {
  date: string;
  matchIds: string[];
  reason: string;
  strongDay: boolean;
}

export interface MatchSelectionResponse {
  selections: MatchSelectionItem[];
}

const MATCH_SELECTION_SCHEMA = {
  type: 'json_schema' as const,
  name: 'match_selection',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      selections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            date: { type: 'string' },
            matchIds: { type: 'array', items: { type: 'string' } },
            reason: { type: 'string' },
            strongDay: { type: 'boolean' },
          },
          required: ['date', 'matchIds', 'reason', 'strongDay'],
          additionalProperties: false,
        },
      },
    },
    required: ['selections'],
    additionalProperties: false,
  },
};

@Injectable()
export class OpenAiService implements OnModuleInit {
  private readonly logger = new Logger(OpenAiService.name);
  private client: OpenAI | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const apiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      this.logger.warn('OPENAI_API_KEY not set — AI match selection disabled');
      return;
    }
    this.client = new OpenAI({ apiKey });
  }

  async selectMatches(
    system: string,
    user: string,
  ): Promise<MatchSelectionResponse> {
    if (!this.client) throw new Error('OpenAI not configured');
    const res = await this.client.responses.create({
      model: this.config.getOrThrow<string>('OPENAI_MODEL'),
      instructions: system,
      input: user,
      text: { format: MATCH_SELECTION_SCHEMA },
    });
    return JSON.parse(res.output_text) as MatchSelectionResponse;
  }
}
