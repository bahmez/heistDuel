import { IsString, IsNotEmpty } from 'class-validator';

export class CreateLobbyDto {
  @IsString()
  @IsNotEmpty()
  playerAddress!: string;

  @IsString()
  @IsNotEmpty()
  seedCommit!: string;

  @IsString()
  @IsNotEmpty()
  seedSecret!: string;
}
