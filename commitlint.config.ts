// Types and scopes mirror docs/05 "Git"; keep the two lists in sync.
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'type-enum': [
      2,
      'always',
      ['feat', 'fix', 'refactor', 'perf', 'test', 'docs', 'build', 'ci', 'chore'],
    ],
    'scope-enum': [
      2,
      'always',
      [
        'indexer',
        'api',
        'db',
        'chain',
        'config',
        'obs',
        'contracts',
        'helm',
        'infra',
        'ci',
        'docs',
        'deps',
        'repo',
      ],
    ],
  },
};
