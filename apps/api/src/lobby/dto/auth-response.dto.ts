import { IsString, IsNotEmpty } from 'class-validator';

/** Payload sent by the frontend after signing an auth-entry preimage. */
export class AuthResponseDto {
  @IsString()
  @IsNotEmpty()
  purpose!: string;

  @IsString()
  @IsNotEmpty()
  playerAddress!: string;

  /** Raw ed25519 signature (base64-encoded) or full SorobanAuthorizationEntry XDR. */
  @IsString()
  @IsNotEmpty()
  signatureBase64!: string;
}
