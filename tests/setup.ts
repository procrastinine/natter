import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { resetPostCommitTasksForTests } from '../src/core/post-commit-task'
import { __resetRepositoryQueriesForTests } from '../src/store/reactive-query'

afterEach(() => {
  cleanup()
  resetPostCommitTasksForTests()
  __resetRepositoryQueriesForTests()
})
