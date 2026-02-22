import {
  Controller,
  Post,
  Body,
  HttpCode,
  HttpStatus,
  Logger,
  Get,
  OnModuleInit,
} from '@nestjs/common';
import {
  IsString,
  IsNumber,
  IsInt,
  IsArray,
  IsOptional,
  ArrayMinSize,
  ArrayMaxSize,
  Min,
  Max,
} from 'class-validator';
import { ProofService, type ProveInputs } from './proof.service';

// ─── DTO ─────────────────────────────────────────────────────────────────────

class ProveTurnDto implements ProveInputs {
  // Private: map data
  @IsString()  mapWalls!: string;
  @IsString()  mapLoot!: string;

  // Private: position + nonce
  @IsInt() @Min(0)   posX!: number;
  @IsInt() @Min(0)   posY!: number;
  @IsString()        posNonce!: string;

  // Private: path
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7)  pathX!: number[];
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(7)  pathY!: number[];
  @IsInt() @Min(0) @Max(6)                      pathLen!: number;

  // Private: new pos nonce
  @IsString()  newPosNonce!: string;

  // Public: turn data
  @IsInt()           sessionId!: number;
  @IsInt()           turnIndex!: number;
  @IsInt() @Min(1) @Max(2)  playerTag!: number;
  @IsNumber()        scoreDelta!: number;
  @IsInt() @Min(0)   lootDelta!: number;
  @IsInt() @Min(0) @Max(1)  noPathFlag!: number;

  // Optional: pre-computed values for logging
  @IsOptional() @IsString()  posCommitBefore?: string;
  @IsOptional() @IsString()  posCommitAfter?: string;
}

// ─── Controller ──────────────────────────────────────────────────────────────

@Controller('proof')
export class ProofController implements OnModuleInit {
  private readonly logger = new Logger(ProofController.name);

  constructor(private readonly proofService: ProofService) {}

  onModuleInit() {
    void this.proofService.warmUp();
  }

  /**
   * GET /api/proof/status
   * Health check: verifies Groth16 circuit artefacts are available.
   */
  @Get('status')
  status() {
    const s = this.proofService.checkStatus();
    const ready = s.circuitReady && s.zkeyReady;
    return {
      ...s,
      ready,
      mode: 'groth16-bn254',
      message: ready
        ? 'Groth16 proof generation available (snarkjs, ~1–5s per proof)'
        : [
            !s.circuitReady && 'Circuit WASM missing — run: npm run compile',
            !s.zkeyReady && 'Proving key missing — run: npm run setup',
          ]
          .filter(Boolean)
          .join('; ') +
          ' inside apps/circuits/turn_validity_g16/',
    };
  }

  /**
   * POST /api/proof/prove
   *
   * Generate a Groth16 ZK proof for a game turn.
   *
   * Returns `proofBlobHex` — the 292-byte blob (n_pub + pi_hash + A + B + C)
   * ready to submit to the Soroban heist contract as `proof_blob`.
   *
   * Proof generation time: ~1–5 seconds (vastly improved from UltraHonk WASM).
   */
  @Post('prove')
  @HttpCode(HttpStatus.OK)
  async prove(@Body() dto: ProveTurnDto): Promise<{ proofBlobHex: string }> {
    this.logger.log(
      `[prove] Turn #${dto.turnIndex} player ${dto.playerTag} session ${dto.sessionId}`,
    );
    const proofBlobHex = await this.proofService.generateProof(dto);
    return { proofBlobHex };
  }
}
