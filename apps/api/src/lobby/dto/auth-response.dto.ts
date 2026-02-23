import { IsString, IsNotEmpty } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

/** Payload sent by the frontend after signing an auth-entry preimage. */
export class AuthResponseDto {
  @ApiProperty({
    description: 'Identifies which transaction step requires the signature (e.g. "start_game", "begin_match")',
    example: 'start_game',
  })
  @IsString()
  @IsNotEmpty()
  purpose!: string;

  @ApiProperty({
    description: 'Stellar address (G…) of the signing player',
    example: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
  })
  @IsString()
  @IsNotEmpty()
  playerAddress!: string;

  @ApiProperty({
    description: 'Base64-encoded raw ed25519 signature or full SorobanAuthorizationEntry XDR signed by the player wallet',
    example: 'AAAAAQAAAA...(base64 XDR)',
  })
  @IsString()
  @IsNotEmpty()
  signatureBase64!: string;
}
