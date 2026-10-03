// ESLint flat config for the whole repository: the Node server (ESM), the
// scripts, and the React SPA. Formatting is Prettier's job, so every stylistic
// rule is switched off by eslint-config-prettier at the end.
import js from '@eslint/js';
import globals from 'globals';
import react from 'eslint-plugin-react';
import reactHooks from 'eslint-plugin-react-hooks';
import prettier from 'eslint-config-prettier';

export default [
  { ignores: ['**/node_modules/**', 'web/dist/**', 'coverage/**'] },

  js.configs.recommended,

  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
    rules: {
      // An underscore marks a parameter that must exist but is not used
      // (Express error handlers need four arguments to be one).
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'off',
    },
  },

  // Server, scripts and tooling: Node, ES modules.
  {
    files: ['server/**/*.js', 'scripts/**/*.mjs', '*.js', 'web/*.config.js'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: { ...globals.node } },
  },
  {
    files: ['server/src/**/*.js'],
    rules: {
      // Everything server-side logs through lib/logger.js.
      'no-console': 'error',
    },
  },

  // The SPA.
  {
    files: ['web/src/**/*.{js,jsx}'],
    plugins: { react, 'react-hooks': reactHooks },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...react.configs.flat.recommended.rules,
      ...react.configs.flat['jsx-runtime'].rules,
      'react/prop-types': 'off',
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    files: ['web/src/**/*.test.{js,jsx}', 'web/src/test/**'],
    languageOptions: { globals: { ...globals.node } },
  },

  prettier,
];
