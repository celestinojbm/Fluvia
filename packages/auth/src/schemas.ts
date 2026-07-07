import { z } from 'zod';

/**
 * Politica de password estilo NIST: longitud como control principal
 * (min 10, max 128), sin reglas de composicion arbitrarias.
 */
export const PasswordSchema = z.string().min(10).max(128);

export const RegisterSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: PasswordSchema,
  })
  .strict();

export type RegisterInput = z.infer<typeof RegisterSchema>;

export const LoginSchema = z
  .object({
    email: z.string().trim().email().max(254),
    password: z.string().min(1).max(128),
  })
  .strict();

export type LoginInput = z.infer<typeof LoginSchema>;

export const VerifyEmailSchema = z
  .object({
    token: z.string().min(10).max(200),
  })
  .strict();

export type VerifyEmailInput = z.infer<typeof VerifyEmailSchema>;

/** Codigo TOTP de 6 digitos o codigo de respaldo (formato xxxx-xxxx-xx). */
export const MfaCodeSchema = z.string().trim().min(6).max(20);

export const MfaVerifySchema = z
  .object({
    challenge_token: z.string().min(10).max(200),
    code: MfaCodeSchema,
  })
  .strict();
export type MfaVerifyInput = z.infer<typeof MfaVerifySchema>;

export const MfaCodeOnlySchema = z.object({ code: MfaCodeSchema }).strict();
export type MfaCodeOnlyInput = z.infer<typeof MfaCodeOnlySchema>;

/** TM-02: re-autenticación por password (step-up de usuarios sin MFA). */
export const StepUpPasswordSchema = z
  .object({
    password: z.string().min(1).max(128),
  })
  .strict();
export type StepUpPasswordInput = z.infer<typeof StepUpPasswordSchema>;
