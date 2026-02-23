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
import { IsString, IsNotEmpty } from 'class-validator';
import { Observable } from 'rxjs';
import { LobbyService } from './lobby.service';
import { CreateLobbyDto } from './dto/create-lobby.dto';
import { JoinLobbyDto } from './dto/join-lobby.dto';
import { AuthResponseDto } from './dto/auth-response.dto';

class MapSecretDto {
  @IsString()
  @IsNotEmpty()
  playerAddress!: string;

  @IsString()
  @IsNotEmpty()
  mapSecret!: string;
}

class BeginMatchDto {
  @IsString()
  @IsNotEmpty()
  mapCommitment!: string;

  @IsString()
  @IsNotEmpty()
  p1PosCommit!: string;

  @IsString()
  @IsNotEmpty()
  p2PosCommit!: string;
}

@Controller('lobby')
export class LobbyController {
  private readonly logger = new Logger(LobbyController.name);

  constructor(private readonly lobbyService: LobbyService) {}

  @Get('/health')
  health() {
    return { service: 'api', status: 'ok' };
  }

  /**
   * POST /api/lobby
   * Create a new game lobby for player 1.
   * Player provides both their dice seed commit/secret and their map seed commit/secret.
   */
  @Post()
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
  async getLobby(@Param('gameId') gameId: string) {
    return this.lobbyService.getLobbyPublicView(gameId);
  }

  /**
   * GET /api/lobby/:gameId/game-state
   *
   * Returns the full on-chain game state (GameView) for a session.
   * Uses the backend admin keypair to satisfy get_game()'s require_auth constraint.
   */
  @Get(':gameId/game-state')
  async getGameState(@Param('gameId') gameId: string) {
    return this.lobbyService.getGameState(gameId);
  }

  @Sse(':gameId/events')
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
   *
   * ZK Map Secret Relay endpoint.
   *
   * Called by each player during the 'relaying' phase.
   * The backend verifies the secret matches the on-chain commitment, then
   * returns the opponent's secret so both players can compute the shared map_seed.
   *
   * Flow:
   *   1. Lobby enters 'relaying' phase after both dice seeds are revealed.
   *   2. P1 calls POST /lobby/:gameId/map-secret → receives P2's secret.
   *   3. P2 calls POST /lobby/:gameId/map-secret → receives P1's secret.
   *   4. Each player computes: map_seed = keccak(own_secret XOR opponent_secret).
   *   5. Each player computes: map_data = generate_map(map_seed).
   *   6. Each player computes: map_commitment = keccak(map_data).
   *   7. Players call POST /lobby/:gameId/begin-match with the commitments.
   */
  @Post(':gameId/map-secret')
  @HttpCode(HttpStatus.OK)
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
   *
   * Triggers the begin_match on-chain transaction.
   * Called by any authorized party (typically the backend or a player)
   * after both players have exchanged map secrets and computed commitments.
   *
   * Both players must have agreed on the same map_commitment off-chain
   * before calling this endpoint.
   */
  @Post(':gameId/begin-match')
  @HttpCode(HttpStatus.OK)
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
   *
   * Skips the active player's turn when they have already exited the map.
   * Admin-only on-chain; the backend signs and submits the pass_turn transaction.
   * Called by the frontend after submitting its own turn when it detects
   * that the new active player (the opponent) has exited.
   */
  @Post(':gameId/pass-turn')
  @HttpCode(HttpStatus.OK)
  async passTurn(@Param('gameId') gameId: string) {
    await this.lobbyService.passTurn(gameId);
    return { ok: true };
  }
}
