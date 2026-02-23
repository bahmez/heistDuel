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
  ApiTags,
  ApiOperation,
  ApiBody,
  ApiResponse,
  ApiProperty,
  ApiPropertyOptional,
} from '@nestjs/swagger';
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
  // ── Private: map data ──────────────────────────────────────────────────────

  @ApiProperty({
    description: 'Hex-encoded 18-byte wall bitset (144 cells, bit N = cell N is a wall)',
    example: '0000000000000000000000000000000000000000',
  })
  @IsString()
  mapWalls!: string;

  @ApiProperty({
    description: 'Hex-encoded 18-byte loot bitset (144 cells, bit N = cell N has loot; only cells 0-126 allowed)',
    example: '0000000000000000000000000000000000000000',
  })
  @IsString()
  mapLoot!: string;

  // ── Private: current position + nonce ──────────────────────────────────────

  @ApiProperty({ description: 'Player X coordinate (0-11) at turn start', example: 1, minimum: 0 })
  @IsInt()
  @Min(0)
  posX!: number;

  @ApiProperty({ description: 'Player Y coordinate (0-11) at turn start', example: 1, minimum: 0 })
  @IsInt()
  @Min(0)
  posY!: number;

  @ApiProperty({
    description: 'Hex-encoded 32-byte position nonce (BN254 Fr element, first byte always 0)',
    example: '00a1b2c3d4e5f601020304050607080910111213141516171819202122232425',
  })
  @IsString()
  posNonce!: string;

  // ── Private: path ──────────────────────────────────────────────────────────

  @ApiProperty({
    description: 'X coordinates of the path cells (1 to 7 entries, padded to 7 if shorter)',
    example: [1, 2, 3],
    isArray: true,
    minItems: 1,
    maxItems: 7,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  pathX!: number[];

  @ApiProperty({
    description: 'Y coordinates of the path cells (1 to 7 entries, padded to 7 if shorter)',
    example: [1, 1, 1],
    isArray: true,
    minItems: 1,
    maxItems: 7,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(7)
  pathY!: number[];

  @ApiProperty({
    description: 'Actual number of steps taken (0 = skip turn, max 6)',
    example: 2,
    minimum: 0,
    maximum: 6,
  })
  @IsInt()
  @Min(0)
  @Max(6)
  pathLen!: number;

  // ── Private: new position nonce ────────────────────────────────────────────

  @ApiProperty({
    description: 'Hex-encoded 32-byte new position nonce after the move',
    example: '00b2c3d4e5f607080910111213141516171819202122232425262728293031',
  })
  @IsString()
  newPosNonce!: string;

  // ── Private: exit cell ────────────────────────────────────────────────────

  @ApiProperty({ description: 'Exit cell X coordinate (0-11)', example: 5, minimum: 0, maximum: 11 })
  @IsInt()
  @Min(0)
  @Max(11)
  exitX!: number;

  @ApiProperty({ description: 'Exit cell Y coordinate (0-11)', example: 5, minimum: 0, maximum: 11 })
  @IsInt()
  @Min(0)
  @Max(11)
  exitY!: number;

  // ── Public: turn data ─────────────────────────────────────────────────────

  @ApiProperty({ description: 'On-chain session ID (u32)', example: 42 })
  @IsInt()
  sessionId!: number;

  @ApiProperty({ description: 'Current turn index (0-based)', example: 4 })
  @IsInt()
  turnIndex!: number;

  @ApiProperty({ description: 'Player tag: 1 = player 1, 2 = player 2', example: 1, minimum: 1, maximum: 2 })
  @IsInt()
  @Min(1)
  @Max(2)
  playerTag!: number;

  @ApiProperty({
    description: 'Net score change for this turn (loot - camera hits - 2×laser hits). Can be negative.',
    example: 1,
  })
  @IsNumber()
  scoreDelta!: number;

  @ApiProperty({ description: 'Number of new loot items collected this turn', example: 1, minimum: 0 })
  @IsInt()
  @Min(0)
  lootDelta!: number;

  @ApiProperty({ description: '1 if the player has no valid moves (forced skip), 0 otherwise', example: 0, minimum: 0, maximum: 1 })
  @IsInt()
  @Min(0)
  @Max(1)
  noPathFlag!: number;

  @ApiProperty({ description: '1 if the player reached the exit cell this turn, 0 otherwise', example: 0, minimum: 0, maximum: 1 })
  @IsInt()
  @Min(0)
  @Max(1)
  exitedFlag!: number;

  // ── Optional: pre-computed commitments (for backend logging/validation) ────

  @ApiPropertyOptional({
    description: 'Hex-encoded Poseidon3(x, y, posNonce) before the move — used for log cross-checks',
    example: 'a1b2c3d4e5f6...',
  })
  @IsOptional()
  @IsString()
  posCommitBefore?: string;

  @ApiPropertyOptional({
    description: 'Hex-encoded Poseidon3(x, y, newPosNonce) after the move — used for log cross-checks',
    example: 'd4e5f6a1b2c3...',
  })
  @IsOptional()
  @IsString()
  posCommitAfter?: string;
}

// ─── Controller ──────────────────────────────────────────────────────────────

@ApiTags('Proof')
@Controller('proof')
export class ProofController implements OnModuleInit {
  private readonly logger = new Logger(ProofController.name);

  constructor(private readonly proofService: ProofService) {}

  onModuleInit() {
    void this.proofService.warmUp();
  }

  /**
   * GET /api/proof/status
   */
  @Get('status')
  @ApiOperation({
    summary: 'Proof system status',
    description:
      'Returns whether the Groth16 circuit WASM and proving key (zkey) are loaded and ready. ' +
      'If not ready, indicates which artefact is missing and how to regenerate it.',
  })
  @ApiResponse({
    status: 200,
    description: 'Proof system status',
    schema: {
      example: {
        circuitReady: true,
        zkeyReady: true,
        ready: true,
        mode: 'groth16-bn254',
        message: 'Groth16 proof generation available (snarkjs, ~1–5s per proof)',
      },
    },
  })
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
   */
  @Post('prove')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Generate a Groth16 ZK proof',
    description:
      'Generates a Groth16 turn-validity proof using snarkjs and the BN254 proving key.\n\n' +
      'The proof attests — without revealing private data — that:\n' +
      '- The path is valid (steps ≤ roll, no walls, connected cells)\n' +
      '- Score delta matches loot collected minus hazard penalties\n' +
      '- Position commitments are correct (Poseidon3)\n' +
      '- Loot mask is consistent with lootDelta\n\n' +
      'Returns `proofBlobHex` — a 584-char hex string encoding the 292-byte blob ' +
      '`[n_pub=1][pi_hash (32B)][pi_A (64B)][pi_B (128B)][pi_C (64B)]` ' +
      'ready to submit as `proof_blob` to the Soroban heist contract.\n\n' +
      '**Typical generation time: 1–5 seconds.**',
  })
  @ApiBody({ type: ProveTurnDto })
  @ApiResponse({
    status: 200,
    description: 'Proof generated successfully',
    schema: {
      example: {
        proofBlobHex: '00000001a3f2c1d4...584 hex chars total',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Invalid inputs or circuit constraint violation' })
  @ApiResponse({ status: 503, description: 'Circuit artefacts not ready (run setup first)' })
  async prove(@Body() dto: ProveTurnDto): Promise<{ proofBlobHex: string }> {
    this.logger.log(
      `[prove] Turn #${dto.turnIndex} player ${dto.playerTag} session ${dto.sessionId}`,
    );
    const proofBlobHex = await this.proofService.generateProof(dto);
    return { proofBlobHex };
  }
}
