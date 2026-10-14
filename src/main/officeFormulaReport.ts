import type { FormulaCalculationReport } from './officeFormulas'

/** Keep failure counts visible even when a workbook has thousands of diagnostics. */
export function summarizeFormulaReport(report: FormulaCalculationReport): string {
  return JSON.stringify({
    calculated: report.calculated,
    unsupportedCount: report.unsupported.length,
    warningCount: report.warnings.length,
    unsupported: report.unsupported.slice(0, 30),
    warnings: report.warnings.slice(0, 30),
    diagnosticsTruncated: report.unsupported.length > 30 || report.warnings.length > 30,
  })
}
