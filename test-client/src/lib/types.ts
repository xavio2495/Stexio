export type TestStatus = 'idle' | 'running' | 'pass' | 'warn' | 'fail'

export interface TestResult {
  status: 'pass' | 'warn' | 'fail'
  message: string
  log: string[]
  details?: unknown
  durationMs?: number
}

export interface FeatureTest {
  id: string
  title: string
  description: string
  group: 'infrastructure' | 'auth' | 'registry' | 'wallet' | 'payment'
}
