import {
  Body,
  Controller,
  Get,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { DbQaAgentService } from './db-qa-agent.service';
import { HealthService, HealthReport } from './health.service';
import { AskDto, AskResult } from './dto/ask.dto';
import { JwtAuthGuard } from './jwt-auth.guard';

@Controller()
export class DbQaController {
  constructor(
    private readonly agent: DbQaAgentService,
    private readonly health: HealthService,
  ) {}

  @Get('health')
  async healthCheck(
    @Res({ passthrough: true }) res: Response,
  ): Promise<HealthReport> {
    const report = await this.health.getReport();
    if (report.status === 'error') {
      res.status(HttpStatus.SERVICE_UNAVAILABLE);
    }
    return report;
  }

  @Post('ask')
  @UseGuards(JwtAuthGuard)
  async ask(@Body() dto: AskDto): Promise<AskResult> {
    return this.agent.ask(dto.question, dto.include_sql, dto.session_id, null);
  }
}
