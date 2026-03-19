import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { DbQaAgentService } from './db-qa-agent.service';
import { AskDto, AskResult } from './dto/ask.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller()
export class DbQaController {
  constructor(private readonly agent: DbQaAgentService) {}

  @Get('health')
  health() {
    return {
      status: 'ok',
      service: 'pg-middleware-ai',
      timestamp: new Date().toISOString(),
    };
  }

  @Post('ask')
  @UseGuards(JwtAuthGuard)
  async ask(@Body() dto: AskDto): Promise<AskResult> {
    return this.agent.ask(dto.question, dto.include_sql, dto.session_id, null);
  }
}
