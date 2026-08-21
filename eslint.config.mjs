import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettierConfig from 'eslint-config-prettier';

export default tseslint.config(
  // Base ESLint recommended rules
  eslint.configs.recommended,

  // TypeScript ESLint strict rules
  ...tseslint.configs.strict,
  ...tseslint.configs.stylistic,

  // Prettier config to disable conflicting rules
  prettierConfig,

  // Global ignores
  {
    ignores: [
      'dist/',
      'coverage/',
      'node_modules/',
      'src/generated/adm-zip-worker-source.ts',
      'examples/',
      'tests/',
      '**/*.js',
      '**/*.mjs',
      '!eslint.config.mjs',
      '!jest.config.js',
    ],
  },

  // Main configuration for TypeScript files
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // TypeScript specific rules
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-non-null-assertion': 'warn',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
        },
      ],

      // General rules
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-debugger': 'warn',
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'prefer-template': 'error',
    },
  },

  // Node-safety guard for src/process/**: these modules are reused by the Electron-free
  // subpath entry points and by binary validation, so they must never pull in the Electron
  // runtime or the userData-derived path module (paths.ts calls app.getPath at import time).
  {
    files: ['src/process/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'electron',
              message:
                'src/process/** must stay Node-safe. Pass Electron-derived values in as arguments.',
            },
          ],
          patterns: [
            {
              // `electron` itself is covered by `paths` above; this catches the
              // submodule spellings (`electron/main`, `electron/common`, ...).
              group: ['electron/*'],
              message:
                'src/process/** must stay Node-safe. Pass Electron-derived values in as arguments.',
            },
            {
              group: ['**/config/paths.js', '**/config/paths'],
              message:
                'src/process/** must stay Node-safe. config/paths.js resolves Electron userData at import time — pass resolved paths in as arguments.',
            },
          ],
        },
      ],
      // `no-restricted-imports` only sees static imports; a dynamic import() would
      // load Electron just as effectively.
      'no-restricted-syntax': [
        'error',
        {
          selector: 'ImportExpression > Literal[value=/^electron(\\/|$)/]',
          message:
            'src/process/** must stay Node-safe. Do not import Electron dynamically either — pass Electron-derived values in as arguments.',
        },
      ],
    },
  },

  // Test files configuration
  {
    files: ['**/*.test.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
      'no-console': 'off',
    },
  }
);
