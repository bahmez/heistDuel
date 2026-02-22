import { Module } from '@nestjs/common';
import { ProofService } from './proof.service';
import { ProofController } from './proof.controller';

@Module({
  providers: [ProofService],
  controllers: [ProofController],
  exports: [ProofService],
})
export class ProofModule {}
