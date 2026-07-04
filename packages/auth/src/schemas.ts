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
