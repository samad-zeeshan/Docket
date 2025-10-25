// Flat ESLint config. Types-aware rules on source, relaxed on tests and generated output.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['cdk.out/**', 'dist/**', 'node_modules/**', 'coverage/**', 'eval/results/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      // Handlers legitimately take `unknown` off the wire and narrow it, so a blanket
      // no-explicit-any ban costs more than it saves here.
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
  {
    files: ['test/**/*.ts', 'eval/**/*.ts'],
    rules: {
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },
);
