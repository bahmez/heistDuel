import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class JoinLobbyDto {
  @ApiProperty({
    description: 'Stellar address (G…) of player 2',
    example: 'GBVFFWM4NCWJUH7CLKZQKKLV2Z5KFLZUADCQVQZP7NM6GMZQWSQ7KNK',
  })
  @IsString()
  @IsNotEmpty()
  playerAddress!: string;

  @ApiProperty({
    description: 'Dice seed commitment: hex-encoded keccak256(seedSecret)',
    example: 'c5d6e7f8091a2b3c4d5e6f7081920a1b2c3d4e5f601234567890abcdef012345',
  })
  @IsString()
  @IsNotEmpty()
  seedCommit!: string;

  @ApiProperty({
    description: 'Dice seed secret: hex-encoded 32-byte random value (revealed on-chain at reveal_seed)',
    example: '4142434445464748494a4b4c4d4e4f505152535455565758595a5b5c5d5e5f60',
  })
  @IsString()
  @IsNotEmpty()
  seedSecret!: string;

  @ApiProperty({
    description: 'Map seed commitment: hex-encoded keccak256(mapSeedSecret) — committed on-chain',
    example: 'd7e8f9001a2b3c4d5e6f708192031a2b3c4d5e6f7081920a1b2c3d4e5f601234',
  })
  @IsString()
  @IsNotEmpty()
  mapSeedCommit!: string;

  @ApiProperty({
    description: 'Map seed secret: hex-encoded 32-byte random value — kept off-chain, relayed to opponent during ZK setup',
    example: '6162636465666768696a6b6c6d6e6f707172737475767778797a7b7c7d7e7f80',
  })
  @IsString()
  @IsNotEmpty()
  mapSeedSecret!: string;
}
