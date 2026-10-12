import { IntakeService } from './intake/intake.service';
import { Module } from '@nestjs/common';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

@Module({ controllers: [ReportsController], providers: [ReportsService, IntakeService], exports: [ReportsService] })
export class ReportsModule {}
