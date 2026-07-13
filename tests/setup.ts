import '@testing-library/jest-dom/vitest'
import 'fake-indexeddb/auto'
import { cleanup } from '@testing-library/react'
import { afterEach } from 'vitest'
import { __resetMessageStreamProjectionForTests } from '../src/hooks/useMessageStreamProjection'
import { __resetRepositoryQueriesForTests } from '../src/store/reactive-query'

afterEach(() => {
  cleanup()
  __resetMessageStreamProjectionForTests()
  __resetRepositoryQueriesForTests()
})
