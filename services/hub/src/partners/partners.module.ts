import { Module } from '@nestjs/common';
import { ClinicAdapter, LineAdapter, LogisticsAdapter, PaymentAdapter } from './adapters.js';

@Module({
  providers: [PaymentAdapter, LogisticsAdapter, ClinicAdapter, LineAdapter],
  exports: [PaymentAdapter, LogisticsAdapter, ClinicAdapter, LineAdapter],
})
export class PartnersModule {}
