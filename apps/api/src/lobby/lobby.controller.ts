import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  HttpCode,
  HttpStatus,
  Logger,
  Sse,
  MessageEvent,
} from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiParam,
  ApiBody,
  ApiResponse,
  ApiProperty,
} from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';
import { Observable } from 'rxjs';
import { LobbyService } from './lobby.service';
import { CreateLobbyDto } from './dto/create-lobby.dto';
import { JoinLobbyDto } from './dto/join-lobby.dto';
import { AuthResponseDto } from './dto/auth-response.dto';

// ─── Inline DTOs ──────────────────────────────────────────────────────────────

class MapSecretDto {
  @ApiProperty({
    description: 'Stellar address (G…) of the calling player',
    example: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
  })
  @IsString()
  @IsNotEmpty()
  playerAddress!: string;

  @ApiProperty({
    description: 'Hex-encoded 32-byte map seed secret — verified against on-chain commitment before relay',
    example: '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
  })
  @IsString()
  @IsNotEmpty()
  mapSecret!: string;
}

class BeginMatchDto {
  @ApiProperty({
    description: 'Hex-encoded keccak256 commitment of the generated map (walls, loot, cameras, lasers, exit)',
    example: 'a3f2c1d4e5b60718293a4b5c6d7e8f9012345678901234567890abcdef012345',
  })
  @IsString()
  @IsNotEmpty()
  mapCommitment!: string;

  @ApiProperty({
    description: "Player 1's initial position commitment: Poseidon3(spawnX, spawnY, p1Nonce)",
    example: 'b4e1f2a3c5d6789012345678901234567890abcdef0123456789012345678901',
  })
  @IsString()
  @IsNotEmpty()
  p1PosCommit!: string;

  @ApiProperty({
    description: "Player 2's initial position commitment: Poseidon3(spawnX, spawnY, p2Nonce)",
    example: 'c5d6e7f8091a2b3c4d5e6f7081920a1b2c3d4e5f601234567890abcdef012345',
  })
  @IsString()
  @IsNotEmpty()
  p2PosCommit!: string;
}

// ─── Controller ───────────────────────────────────────────────────────────────

@ApiTags('Lobby')
@Controller('lobby')
export class LobbyController {
  private readonly logger = new Logger(LobbyController.name);

  constructor(private readonly lobbyService: LobbyService) {}

  @Get('/health')
  @ApiOperation({ summary: 'Health check', description: 'Returns service status. Used by load balancers and monitoring.' })
  @ApiResponse({ status: 200, description: 'Service is up', schema: { example: { service: 'api', status: 'ok' } } })
  health() {
    return { service: 'api', status: 'ok' };
  }

  /**
   * POST /api/lobby
   * Create a new game lobby for player 1.
   */
  @Post()
  @ApiOperation({
    summary: 'Create a lobby',
    description:
      'Creates a new game lobby for player 1. Stores both seed commitments on-chain via `start_game`, ' +
      'then waits for player 2 to join. Returns a shareable `joinUrl`.',
  })
  @ApiBody({ type: CreateLobbyDto })
  @ApiResponse({
    status: 201,
    description: 'Lobby created successfully',
    schema: {
      example: {
        gameId: 'c7a3f2b1-4d5e-6f78-9012-345678901234',
        sessionId: 42,
        joinUrl: 'https://heistduel.xyz/game/c7a3f2b1-4d5e-6f78-9012-345678901234',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Validation error on request body' })
  async createLobby(@Body() dto: CreateLobbyDto) {
    return this.lobbyService.createLobby(
      dto.playerAddress,
      dto.seedCommit,
      dto.seedSecret,
      dto.mapSeedCommit,
      dto.mapSeedSecret,
    );
  }

  /**
   * POST /api/lobby/:gameId/join
   * Player 2 joins an existing lobby. Automatically triggers game start.
   */
  @Post(':gameId/join')
  @ApiOperation({
    summary: 'Join a lobby (player 2)',
    description:
      'Player 2 joins an existing lobby by providing their seed commitments. ' +
      'Triggers the `start_game` on-chain transaction automatically.',
  })
  @ApiParam({ name: 'gameId', description: 'UUID of the game lobby', example: 'c7a3f2b1-4d5e-6f78-9012-345678901234' })
  @ApiBody({ type: JoinLobbyDto })
  @ApiResponse({
    status: 201,
    description: 'Successfully joined the lobby',
    schema: {
      example: {
        gameId: 'c7a3f2b1-4d5e-6f78-9012-345678901234',
        sessionId: 42,
        player1: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
        player2: 'GBVFFWM4NCWJUH7CLKZQKKLV2Z5KFLZUADCQVQZP7NM6GMZQWSQ7KNK',
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Lobby not found' })
  @ApiResponse({ status: 409, description: 'Lobby already full or game already started' })
  async joinLobby(
    @Param('gameId') gameId: string,
    @Body() dto: JoinLobbyDto,
  ) {
    const lobby = await this.lobbyService.joinLobby(
      gameId,
      dto.playerAddress,
      dto.seedCommit,
      dto.seedSecret,
      dto.mapSeedCommit,
      dto.mapSeedSecret,
    );
    return {
      gameId: lobby.gameId,
      sessionId: lobby.sessionId,
      player1: lobby.player1,
      player2: lobby.player2,
    };
  }

  @Get(':gameId')
  @ApiOperation({
    summary: 'Get lobby public view',
    description: 'Returns the lobby state (phase, players, sessionId) without sensitive game data.',
  })
  @ApiParam({ name: 'gameId', description: 'UUID of the game lobby', example: 'c7a3f2b1-4d5e-6f78-9012-345678901234' })
  @ApiResponse({
    status: 200,
    description: 'Lobby public view',
    schema: {
      example: {
        gameId: 'c7a3f2b1-4d5e-6f78-9012-345678901234',
        sessionId: 42,
        phase: 'active',
        player1: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
        player2: 'GBVFFWM4NCWJUH7CLKZQKKLV2Z5KFLZUADCQVQZP7NM6GMZQWSQ7KNK',
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Lobby not found' })
  async getLobby(@Param('gameId') gameId: string) {
    return this.lobbyService.getLobbyPublicView(gameId);
  }

  /**
   * GET /api/lobby/:gameId/game-state
   */
  @Get(':gameId/game-state')
  @ApiOperation({
    summary: 'Get on-chain game state',
    description:
      'Returns the full `GameView` from the Soroban heist contract for this session. ' +
      'Uses the backend admin keypair to satisfy `get_game()` require_auth. ' +
      'Includes scores, position commitments, timer values, loot mask, and exit flags.',
  })
  @ApiParam({ name: 'gameId', description: 'UUID of the game lobby', example: 'c7a3f2b1-4d5e-6f78-9012-345678901234' })
  @ApiResponse({
    status: 200,
    description: 'Serialized on-chain GameView',
    schema: {
      example: {
        player1: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
        player2: 'GBVFFWM4NCWJUH7CLKZQKKLV2Z5KFLZUADCQVQZP7NM6GMZQWSQ7KNK',
        status: 'Active',
        turnIndex: 4,
        activePlayer: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
        player1Score: '3',
        player2Score: '1',
        p1TimeRemaining: 248,
        p2TimeRemaining: 271,
        lastTurnStartTs: 1706000000,
        player1Exited: false,
        player2Exited: false,
        winner: null,
      },
    },
  })
  @ApiResponse({ status: 404, description: 'Lobby or on-chain session not found' })
  async getGameState(@Param('gameId') gameId: string) {
    return this.lobbyService.getGameState(gameId);
  }

  @Sse(':gameId/events')
  @ApiOperation({
    summary: 'SSE stream — lobby updates',
    description:
      'Server-Sent Events stream. Pushes the lobby public view every time it changes ' +
      '(phase transitions, player joins, auth-entry requests). ' +
      'The frontend keeps this connection open for the full game lifecycle.',
  })
  @ApiParam({ name: 'gameId', description: 'UUID of the game lobby', example: 'c7a3f2b1-4d5e-6f78-9012-345678901234' })
  @ApiResponse({ status: 200, description: 'SSE stream opened (text/event-stream)' })
  streamLobbyEvents(
    @Param('gameId') gameId: string,
  ): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      this.logger.log(`[SSE] Client connected for lobby ${gameId}`);

      const unsubscribe = this.lobbyService.subscribeToLobby(
        gameId,
        (view) => {
          subscriber.next({ data: view });
        },
      );

      return () => {
        this.logger.log(`[SSE] Client disconnected from lobby ${gameId}`);
        unsubscribe();
      };
    });
  }

  @Post(':gameId/auth-response')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Submit wallet signature',
    description:
      'Called by the frontend after a player signs a Soroban auth-entry preimage. ' +
      'The backend uses this signature to assemble and submit the on-chain transaction ' +
      '(`start_game` or `begin_match`).',
  })
  @ApiParam({ name: 'gameId', description: 'UUID of the game lobby', example: 'c7a3f2b1-4d5e-6f78-9012-345678901234' })
  @ApiBody({ type: AuthResponseDto })
  @ApiResponse({ status: 200, description: 'Signature accepted', schema: { example: { ok: true } } })
  @ApiResponse({ status: 400, description: 'Invalid or expired signature' })
  @ApiResponse({ status: 404, description: 'No pending auth request for this purpose' })
  async receiveAuthResponse(
    @Param('gameId') gameId: string,
    @Body() dto: AuthResponseDto,
  ) {
    await this.lobbyService.receiveAuthSignature(
      gameId,
      dto.purpose,
      dto.playerAddress,
      dto.signatureBase64,
    );
    return { ok: true };
  }

  /**
   * POST /api/lobby/:gameId/map-secret
   */
  @Post(':gameId/map-secret')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'ZK map-secret relay',
    description:
      'Called by each player during the `relaying` phase. ' +
      'The backend verifies the submitted secret against the on-chain `mapSeedCommit`, ' +
      'then returns the opponent\'s secret. ' +
      'Both players XOR their secrets to derive the shared `map_seed` and generate the game map.\n\n' +
      '**Flow:**\n' +
      '1. P1 calls → receives P2\'s secret\n' +
      '2. P2 calls → receives P1\'s secret\n' +
      '3. Each player computes `map_seed = keccak(own XOR opponent)` then calls `/begin-match`',
  })
  @ApiParam({ name: 'gameId', description: 'UUID of the game lobby', example: 'c7a3f2b1-4d5e-6f78-9012-345678901234' })
  @ApiBody({ type: MapSecretDto })
  @ApiResponse({
    status: 200,
    description: 'Opponent\'s map secret returned',
    schema: { example: { opponentMapSecret: '4142434445464748494a4b4c4d4e4f50...' } },
  })
  @ApiResponse({ status: 400, description: 'Secret does not match on-chain commitment' })
  @ApiResponse({ status: 425, description: 'Opponent has not yet submitted their secret — retry later' })
  async relayMapSecret(
    @Param('gameId') gameId: string,
    @Body() dto: MapSecretDto,
  ) {
    return this.lobbyService.relayMapSecret(
      gameId,
      dto.playerAddress,
      dto.mapSecret,
    );
  }

  /**
   * POST /api/lobby/:gameId/begin-match
   */
  @Post(':gameId/begin-match')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Trigger begin_match on-chain',
    description:
      'Submits the `begin_match` Soroban transaction with the agreed map commitment and ' +
      'initial position commitments. Both players must have previously signed via `/auth-response`.\n\n' +
      'Returns the derived `sessionSeed` which the frontend stores locally for ' +
      'dice-roll computation and ZK proof generation.',
  })
  @ApiParam({ name: 'gameId', description: 'UUID of the game lobby', example: 'c7a3f2b1-4d5e-6f78-9012-345678901234' })
  @ApiBody({ type: BeginMatchDto })
  @ApiResponse({
    status: 200,
    description: 'begin_match submitted successfully',
    schema: {
      example: {
        ok: true,
        sessionSeed: 'f0e1d2c3b4a5968778695a4b3c2d1e0f0102030405060708090a0b0c0d0e0f10',
      },
    },
  })
  @ApiResponse({ status: 400, description: 'Commitments mismatch or seeds not yet revealed' })
  async beginMatch(
    @Param('gameId') gameId: string,
    @Body() dto: BeginMatchDto,
  ) {
    const { sessionSeed } = await this.lobbyService.handleBeginMatch(
      gameId,
      dto.mapCommitment,
      dto.p1PosCommit,
      dto.p2PosCommit,
    );
    return { ok: true, sessionSeed };
  }

  /**
   * POST /api/lobby/:gameId/pass-turn
   */
  @Post(':gameId/pass-turn')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Pass turn for exited player (admin)',
    description:
      'Submits the admin-only `pass_turn` Soroban transaction to skip the active player\'s turn ' +
      'when they have already exited the map. ' +
      'The backend signs the transaction with the admin keypair.\n\n' +
      'Called by the frontend after detecting that the new active player (opponent) ' +
      'has their `opponentExited` flag set.',
  })
  @ApiParam({ name: 'gameId', description: 'UUID of the game lobby', example: 'c7a3f2b1-4d5e-6f78-9012-345678901234' })
  @ApiResponse({ status: 200, description: 'Turn passed successfully', schema: { example: { ok: true } } })
  @ApiResponse({ status: 400, description: 'Active player has not exited — pass not allowed' })
  @ApiResponse({ status: 404, description: 'Lobby or session not found' })
  async passTurn(@Param('gameId') gameId: string) {
    await this.lobbyService.passTurn(gameId);
    return { ok: true };
  }
}
