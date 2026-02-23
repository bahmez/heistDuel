import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateLobbyDto {
  @ApiProperty({
    description: 'Stellar address (G…) of player 1',
    example: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
  })
  @IsString()
  @IsNotEmpty()
  playerAddress!: string;

  @ApiProperty({
    description: 'Dice seed commitment: hex-encoded keccak256(seedSecret)',
    example: 'a3f2c1d4e5b60718293a4b5c6d7e8f9012345678901234567890abcdef012345',
  })
  @IsString()
  @IsNotEmpty()
  seedCommit!: string;

  @ApiProperty({
    description: 'Dice seed secret: hex-encoded 32-byte random value (revealed on-chain at reveal_seed)',
    example: '0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
  })
  @IsString()
  @IsNotEmpty()
  seedSecret!: string;

  @ApiProperty({
    description: 'Map seed commitment: hex-encoded keccak256(mapSeedSecret) — committed on-chain',
    example: 'b4e1f2a3c5d6789012345678901234567890abcdef0123456789012345678901',
  })
  @IsString()
  @IsNotEmpty()
  mapSeedCommit!: string;

  @ApiProperty({
    description: 'Map seed secret: hex-encoded 32-byte random value — kept off-chain, relayed to opponent during ZK setup',
    example: '2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40',
  })
  @IsString()
  @IsNotEmpty()
  mapSeedSecret!: string;
}
