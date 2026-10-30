module.exports = {
  root: true,
  env: { es2022: true, node: true },
  parserOptions: { ecmaVersion: 'latest' },
  extends: ['eslint:recommended'],
  ignorePatterns: ['node_modules/', 'build/', '.catalyst/', 'functions/'],
  rules: { 'no-unused-vars': 'off', 'no-empty': ['error', { allowEmptyCatch: true }] },
};
