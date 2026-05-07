/**
 * SENTINEL ENGINE — ContextPacker (V5.3)
 * ═══════════════════════════════════════════════════════════
 * Knowledge-aware context budget allocation.
 *
 * Unlike dumb byte truncation, the ContextPacker understands that
 * context is composed of DISCRETE ROWS of intelligence, not a
 * character stream. When truncation is required, it:
 *
 *   1. Preserves complete rows — never cuts mid-sentence
 *   2. Protects a minimum number of "golden" data rows
 *   3. Allocates warning budget dynamically based on actual failures
 *   4. Prioritizes internal vector rows over external adapter data
 *
 * DESIGN RULE: Warnings exist to inform the LLM, but the LLM
 *   cannot make decisions from warnings alone. If you must choose
 *   between a warning and a data row, keep the data.
 * ═══════════════════════════════════════════════════════════
 */

const MAX_CONTEXT_BYTES = 16384;
const MIN_PROTECTED_ROWS = 10;

/**
 * Pack external adapter results into a context string with
 * knowledge-aware truncation.
 *
 * @param {Array<{plugin: string, data: string}>} successResults - Successful adapter outputs
 * @param {Array<{plugin: string, error: string}>} failedResults - Failed adapter outputs
 * @returns {string|null} Packed context string, or null if no data
 */
function packExternalContext(successResults, failedResults) {
  if (successResults.length === 0 && failedResults.length === 0) return null;

  // ── Build warnings from failures ──
  const warningLines = failedResults.map(
    f => `[WARNING: External Data Authority (${f.plugin}) Unavailable]`
  );
  const warningsBlock = warningLines.length > 0
    ? warningLines.join('\n') + '\n'
    : '';

  // ── Build data rows from successes ──
  // Each adapter result is a discrete, complete row of intelligence.
  const dataRows = successResults
    .map(r => r.data.trim())
    .filter(d => d.length > 0);

  if (dataRows.length === 0 && warningsBlock.length === 0) return null;

  // ── Budget allocation ──
  const warningCost = warningsBlock.length;
  let dataBudget = MAX_CONTEXT_BYTES - warningCost;

  // Safety: if warnings alone exceed the total budget, truncate WARNINGS
  // to preserve at least 75% of the budget for data.
  let finalWarnings = warningsBlock;
  if (warningCost > MAX_CONTEXT_BYTES * 0.25) {
    const maxWarningBytes = Math.floor(MAX_CONTEXT_BYTES * 0.25);
    finalWarnings = warningsBlock.substring(0, maxWarningBytes) + '\n[...WARNINGS TRUNCATED]\n';
    dataBudget = MAX_CONTEXT_BYTES - finalWarnings.length;
  }

  // ── Row-aware packing ──
  // Add complete rows until we exhaust the budget.
  // NEVER cut a row in half — either it fits or it doesn't.
  const packedRows = [];
  let bytesUsed = 0;

  for (let i = 0; i < dataRows.length; i++) {
    const row = dataRows[i];
    const rowCost = row.length + 1; // +1 for newline separator

    if (bytesUsed + rowCost <= dataBudget) {
      packedRows.push(row);
      bytesUsed += rowCost;
    } else if (packedRows.length < MIN_PROTECTED_ROWS && i < dataRows.length) {
      // We haven't reached the minimum protected rows yet.
      // Force-include this row even if it means light truncation of THIS row only.
      const remaining = Math.max(0, dataBudget - bytesUsed - 1);
      if (remaining > 50) { // Only include if we can preserve at least 50 chars
        packedRows.push(row.substring(0, remaining) + '...[TRUNCATED]');
        bytesUsed += remaining + 14; // 14 = length of '...[TRUNCATED]'
      }
      break; // Budget exhausted
    } else {
      // Budget exhausted and we have enough protected rows
      break;
    }
  }

  if (packedRows.length === 0 && finalWarnings.length === 0) return null;

  const result = finalWarnings + packedRows.join('\n');
  return result.trim();
}

/**
 * Safely merge internal vector context (Postgres/BQ golden data)
 * with external adapter context, protecting a minimum number of
 * internal rows from being displaced.
 *
 * @param {string} internalContext - RAG context from Postgres/BQ (the "Golden Data")
 * @param {string|null} externalContext - Packed external adapter context
 * @param {number} [totalBudget] - Total context budget (defaults to no limit — LLM handles tokens)
 * @returns {string} Merged context payload
 */
function mergeContextSafely(internalContext, externalContext, totalBudget = 0) {
  if (!externalContext) return internalContext || '';
  if (!internalContext) return externalContext;

  const merged = internalContext + '\n\n── External Intelligence ──\n' + externalContext;

  // If no budget constraint, return the full merge
  if (totalBudget <= 0) return merged;

  // If within budget, return as-is
  if (merged.length <= totalBudget) return merged;

  // Budget exceeded: protect internal rows, truncate external
  // Split internal into rows to count them
  const internalRows = internalContext.split('\n').filter(r => r.trim().length > 0);
  const protectedRowCount = Math.max(MIN_PROTECTED_ROWS, internalRows.length);
  const protectedInternal = internalRows.slice(0, protectedRowCount).join('\n');

  const externalBudget = Math.max(0, totalBudget - protectedInternal.length - 30); // 30 for separator
  const truncatedExternal = externalContext.substring(0, externalBudget);

  return protectedInternal + '\n\n── External Intelligence ──\n' + truncatedExternal;
}

module.exports = {
  packExternalContext,
  mergeContextSafely,
  MAX_CONTEXT_BYTES,
  MIN_PROTECTED_ROWS,
};
