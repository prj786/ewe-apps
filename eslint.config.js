import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import solid from 'eslint-plugin-solid/configs/typescript'
import globals from 'globals'
import tseslint from 'typescript-eslint'

export default tseslint.config(
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/target/**', '**/src-tauri/gen/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  ...tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      '@typescript-eslint/no-unnecessary-condition': 'off',
      '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
      '@typescript-eslint/no-confusing-void-expression': 'off',
      '@typescript-eslint/no-non-null-assertion': 'error',
    },
  },
  {
    files: ['packages/shared/**'],
    languageOptions: { globals: globals.node },
  },
  {
    files: ['packages/ui/src/**', 'apps/*/src/**'],
    ...solid,
    languageOptions: { ...solid.languageOptions, globals: globals.browser },
    rules: {
      ...solid.rules,
      'no-unassigned-vars': 'off',
      'solid/reactivity': ['warn', { customReactiveFunctions: ['run', 'item'] }],
    },
  },
  {
    files: ['**/vite.config.ts', '**/vitest.config.ts'],
    languageOptions: { globals: globals.node },
  },
  { files: ['**/*.js', '**/*.mjs'], ...tseslint.configs.disableTypeChecked },
  prettier,
)
