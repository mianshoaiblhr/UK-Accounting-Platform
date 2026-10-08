import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/generated/**', 'infra/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Architecture rule: only @uk/db may touch Prisma directly, so tenant context cannot be bypassed.
      'no-restricted-imports': ['error', { paths: [{ name: '@prisma/client', message: 'Import from @uk/db instead.' }] }],
    },
  },
  { files: ['packages/db/**'], rules: { 'no-restricted-imports': 'off' } },
);
