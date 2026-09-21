/** Offline evaluation of an exported report against separately maintained labels. No API calls. */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { checkRecordSchema } from '../src/shared/business-check'

const label = z.enum(['consistent', 'inconsistent', 'insufficient'])
const resultSchema = z.object({
  engine: z.string(),
  model: z.string(),
  label: label.optional(),
  error: z.string().optional(),
})
const reportSchema = z.object({
  config: z.object({ sheetName: z.string(), engines: z.array(z.string()) }),
  structuralStale: z.boolean(),
  rows: z.array(
    z.object({ record: checkRecordSchema, stale: z.boolean(), results: z.array(resultSchema) }),
  ),
})
const labelsSchema = z.object({
  version: z.string(),
  cases: z.array(
    z.object({
      sheetName: z.string(),
      split: z.enum(['development', 'test']),
      record: checkRecordSchema,
      expected: z.string(),
    }),
  ),
})
async function main(): Promise<void> {
  const [reportPath, labelsPath] = process.argv.slice(2)
  if (!reportPath || !labelsPath)
    throw new Error(
      'Usage: npx tsx apps/sheets/scripts/evaluate-business-check.ts <report.json> <labels.json>',
    )
  const report = reportSchema.parse(JSON.parse(await readFile(reportPath, 'utf8')))
  const labels = labelsSchema.parse(JSON.parse(await readFile(labelsPath, 'utf8')))
  if (report.structuralStale)
    throw new Error('The report is structurally stale; run a fresh check first.')
  const classes = label.options
  const summaries = []
  for (const split of ['development', 'test'] as const) {
    const truth = labels.cases.filter(
      (c) =>
        c.sheetName === report.config.sheetName &&
        c.split === split &&
        label.safeParse(c.expected).success,
    )
    if (!truth.length) continue
    for (const engine of report.config.engines) {
      const matrix = Object.fromEntries(
        classes.map((expected) => [
          expected,
          Object.fromEntries(classes.map((predicted) => [predicted, 0])),
        ]),
      )
      let covered = 0,
        correct = 0,
        missingOrChanged = 0,
        failures = 0
      for (const sample of truth) {
        const row = report.rows.find(
          (row) => !row.stale && JSON.stringify(row.record) === JSON.stringify(sample.record),
        )
        if (!row) {
          missingOrChanged++
          continue
        }
        const result = row.results.find((result) => result.engine === engine)
        if (!result?.label || result.error) {
          failures++
          continue
        }
        covered++
        matrix[sample.expected]![result.label]!++
        if (result.label === sample.expected) correct++
      }
      const inconsistent = matrix.inconsistent!
      const normal = matrix.consistent!
      const sum = (row: Record<string, number>) => Object.values(row).reduce((a, b) => a + b, 0)
      summaries.push({
        split,
        engine,
        models: [
          ...new Set(
            report.rows.flatMap((row) =>
              row.results.filter((r) => r.engine === engine).map((r) => r.model),
            ),
          ),
        ],
        labeledEligible: truth.length,
        validOutputs: covered,
        missingOrChanged,
        failures,
        validOutputCoverage: covered / truth.length,
        accuracyOnValidOutputs: covered ? correct / covered : null,
        inconsistentRecallOnValidOutputs: sum(inconsistent)
          ? inconsistent.inconsistent! / sum(inconsistent)
          : null,
        normalFalseAlarmRateOnValidOutputs: sum(normal) ? normal.inconsistent! / sum(normal) : null,
        confusionMatrix: matrix,
      })
    }
  }
  console.log(
    JSON.stringify(
      {
        labelVersion: labels.version,
        note: 'Synthetic small-sample demonstration; development and test sets are separate. No p95 or production accuracy claim. Timing and all billable attempts remain in the original report.',
        summaries,
      },
      null,
      2,
    ),
  )
}
void main().catch((error) => {
  console.error(error.message)
  process.exitCode = 1
})
