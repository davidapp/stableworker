declare module 'fast-formula-parser' {
  export interface FormulaPosition { sheet: string; row: number; col: number }
  export interface FormulaReference { sheet?: string; row?: number; col?: number; from?: { row: number; col: number }; to?: { row: number; col: number } }
  export class FormulaError extends Error {
    constructor(error: string, message?: string)
    error: string
    static REF: FormulaError
    static NAME: FormulaError
    static VALUE: FormulaError
    static NUM: FormulaError
  }
  export class DepParser {
    constructor(options?: { onVariable?: (name: string, sheet?: string, position?: FormulaPosition) => FormulaReference | null })
    parse(formula: string, position: FormulaPosition): FormulaReference[]
  }
  export default class FormulaParser {
    static FormulaError: typeof FormulaError
    static DepParser: typeof DepParser
    constructor(options?: {
      functions?: Record<string, (...args: unknown[]) => unknown>
      onCell?: (ref: FormulaReference) => unknown
      onRange?: (ref: FormulaReference) => unknown[][]
      onVariable?: (name: string, sheet?: string, position?: FormulaPosition) => FormulaReference | null
    })
    parse(formula: string, position: FormulaPosition): unknown
  }
}
