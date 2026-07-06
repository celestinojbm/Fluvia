import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/node_modules/**', '**/dist/**', '**/.turbo/**', '**/.next/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      // Invariante de CONTRIBUTING: prohibido `any` (el codigo financiero no admite excepciones sin documentar)
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'off',
      eqeqeq: ['error', 'always'],
      'no-console': ['error', { allow: ['error'] }],
    },
  },
  {
    // CLIs y scripts pueden escribir a stdout
    files: ['**/migrate-cli.ts', 'scripts/**'],
    rules: { 'no-console': 'off' },
  },
  {
    // Drills operativos (F4-06b): imprimen el transcript de la rehearsal y
    // conducen JSON de respuestas HTTP suelto. No son código financiero de
    // librería (donde el `any` sí está prohibido), sino scripts de ensayo.
    files: ['**/drills/**'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-explicit-any': 'off' },
  }
);
