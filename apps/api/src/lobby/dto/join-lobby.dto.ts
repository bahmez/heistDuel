import { IsString, IsNotEmpty } from 'class-validator';

export class JoinLobbyDto {
  @IsString()
  @IsNotEmpty()
  playerAddress!: string;

  @IsString()
  @IsNotEmpty()
  seedCommit!: string;

  @IsString()
  @IsNotEmpty()
  seedSecret!: string;

  /** keccak(mapSeedSecret) — committed on-chain. */
  @IsString()
  @IsNotEmpty()
  mapSeedCommit!: string;

  /** Hex-encoded 32-byte map secret — stored temporarily, relayed to opponent after seeds are revealed. */
  @IsString()
  @IsNotEmpty()
  mapSeedSecret!: string;
}
