import { BaseSequencer, type TestSpecification } from 'vitest/node'

export class GlobalTestSequencer extends BaseSequencer {
  sort(files: TestSpecification[]): Promise<TestSpecification[]>
}
