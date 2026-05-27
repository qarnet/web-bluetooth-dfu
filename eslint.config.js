import js from '@eslint/js';

const browserGlobals = {
  navigator: 'readonly',
  window: 'readonly',
  document: 'readonly',
  console: 'readonly',
  crypto: 'readonly',

  Event: 'readonly',
  EventTarget: 'readonly',
  CustomEvent: 'readonly',
  AbortController: 'readonly',

  localStorage: 'readonly',

  Blob: 'readonly',
  File: 'readonly',
  FileReader: 'readonly',
  URL: 'readonly',

  fetch: 'readonly',

  setTimeout: 'readonly',
  clearTimeout: 'readonly',
};

export default [
  {
    ignores: [
      '.direnv/',
      'node_modules/',
      'vendor/',
      'firmware/build*/',
      'test/fixtures/',
      '*.png',

      // These have different runtime globals; lint separately if desired.
      'tools/',
      'tests/',
      'test/',
      'sw.js',
    ],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: browserGlobals,
    },
    rules: {
      // Keep the ruleset intentionally small; this repo is vanilla ESM.
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
