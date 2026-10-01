import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist/', 'coverage/', 'node_modules/'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', destructuredArrayIgnorePattern: '^_' }],
      'no-control-regex': 'off',
    },
  },
  // Copied from the desktop app; kept identical to it rather than restyled.
  { files: ['src/licensing/licenseFormat.ts', 'src/licensing/manifest.ts'], rules: { 'no-useless-assignment': 'off' } },
);
