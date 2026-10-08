import { Global, Module } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { IDENTITY_PROVIDERS, LocalPasswordProvider } from './identity-provider';
import { MfaService } from './mfa.service';
import { PasswordHasher } from './password-hasher';
import { SessionService } from './session.service';

@Global()
@Module({
  controllers: [AuthController],
  providers: [
    PasswordHasher, SessionService, MfaService, AuthService, LocalPasswordProvider,
    // Register future OIDC/SAML providers here (Entra ID, Google Workspace, Auth0...).
    { provide: IDENTITY_PROVIDERS, useFactory: (local: LocalPasswordProvider) => [local], inject: [LocalPasswordProvider] },
  ],
  exports: [SessionService, AuthService, MfaService, PasswordHasher],
})
export class AuthModule {}
