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
import { Observable } from 'rxjs';
import { LobbyService } from './lobby.service';
import { CreateLobbyDto } from './dto/create-lobby.dto';
import { JoinLobbyDto } from './dto/join-lobby.dto';
import { AuthResponseDto } from './dto/auth-response.dto';

/**
 * HTTP controller for lobby and game-setup operations.
 *
 * Real-time lobby updates are delivered via Server-Sent Events (SSE):
 *  - GET /lobby/:gameId/events → SSE stream backed by Firestore `onSnapshot`
 *
 * Auth-entry signing still uses plain HTTP (SSE is read-only):
 *  - POST /lobby/:gameId/auth-response → submit signed preimage
 */
@Controller('lobby')
export class LobbyController {
  private readonly logger = new Logger(LobbyController.name);

  constructor(private readonly lobbyService: LobbyService) {}

  /**
   * GET /api/lobby/health
   * Simple liveness check.
   */
  @Get('/health')
  health() {
    return { service: 'api', status: 'ok' };
  }

  /**
   * POST /api/lobby
   * Create a new game lobby for player 1.
   */
  @Post()
  async createLobby(@Body() dto: CreateLobbyDto) {
    return this.lobbyService.createLobby(
      dto.playerAddress,
      dto.seedCommit,
      dto.seedSecret,
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
    );
    return {
      gameId: lobby.gameId,
      sessionId: lobby.sessionId,
      player1: lobby.player1,
      player2: lobby.player2,
    };
  }

  /**
   * GET /api/lobby/:gameId
   * One-shot REST snapshot of the current lobby state.
   * Useful for initial page load before the SSE stream is established.
   */
  @Get(':gameId')
  async getLobby(@Param('gameId') gameId: string) {
    return this.lobbyService.getLobbyPublicView(gameId);
  }

  /**
   * GET /api/lobby/:gameId/events
   *
   * Server-Sent Events stream for real-time lobby updates.
   * Backed by a Firestore `onSnapshot` listener — the client receives an event
   * immediately (current state) and then on every Firestore document change.
   *
   * Event payload: JSON-encoded `LobbyPublicView` (sanitized, no seed secrets).
   * Includes `pendingAuthRequest` so the client knows when to sign.
   *
   * The stream stays open until the client disconnects; the Firestore listener
   * is cleaned up via the Observable teardown (`return () => unsubscribe()`).
   */
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

  /**
   * POST /api/lobby/:gameId/auth-response
   *
   * Receives a signed auth-entry preimage from the frontend wallet.
   * Writes the signature to Firestore — the backend's `onSnapshot` listener
   * (in `requestRemoteSignature`) picks it up and resolves the awaited Promise,
   * allowing the game-setup flow to continue.
   */
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
}
