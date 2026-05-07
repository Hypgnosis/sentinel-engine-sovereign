import React, { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { Search, ArrowUpDown, ArrowUp, ArrowDown, ChevronLeft, ChevronRight, Database, Grid3x3 } from 'lucide-react';

/**
 * SENTINEL ENGINE V4.9-RC — High-Density Data Grid (2D Fallback)
 * ═══════════════════════════════════════════════════════════════
 * Memoized, virtualized data grid for low-GPU/low-bandwidth
 * environments. Replaces the R3F 3D visualization when WebGL
 * performance is insufficient.
 *
 * Features:
 *   - Sortable columns (click header)
 *   - Search/filter across all fields
 *   - Virtualized row rendering (visible rows only)
 *   - Full Sentinel "Cyber-Purple" theme integration
 *   - Zero useState in animation loops (uses refs)
 * ═══════════════════════════════════════════════════════════════
 */

// ── Severity/trend color mapping ──
const SEVERITY_COLORS = {
  CRITICAL: 'text-red-400 bg-red-400/10 border-red-500/30',
  HIGH: 'text-orange-400 bg-orange-400/10 border-orange-500/30',
  MEDIUM: 'text-amber-400 bg-amber-400/10 border-amber-500/30',
  LOW: 'text-green-400 bg-green-400/10 border-green-500/30',
  MODERATE: 'text-amber-400 bg-amber-400/10 border-amber-500/30',
};

const TREND_ICONS = {
  up: { icon: ArrowUp, color: 'text-green-400' },
  down: { icon: ArrowDown, color: 'text-red-400' },
  stable: { icon: null, color: 'text-amber-400' },
};

const PAGE_SIZE = 25;

const DataGrid = React.memo(function DataGrid({ data = [], columns = [], title = 'Sovereign Grid', className = '' }) {
  const [searchQuery, setSearchQuery] = useState('');
  const [sortConfig, setSortConfig] = useState({ key: null, direction: 'asc' });
  const [currentPage, setCurrentPage] = useState(0);
  const tableRef = useRef(null);

  // ── Auto-detect columns from data if not provided ──
  const resolvedColumns = useMemo(() => {
    if (columns.length > 0) return columns;
    if (data.length === 0) return [];

    // Infer from first row, skip internal fields
    const skipFields = new Set(['embedding', 'id', 'entity_hash', 'tenant_id', '_cachedAt', '_category', '_ttl']);
    return Object.keys(data[0])
      .filter(key => !skipFields.has(key))
      .map(key => ({
        key,
        label: key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
        sortable: true,
      }));
  }, [columns, data]);

  // ── Filtered data ──
  const filteredData = useMemo(() => {
    if (!searchQuery.trim()) return data;
    const q = searchQuery.toLowerCase();
    return data.filter(row =>
      resolvedColumns.some(col => {
        const val = row[col.key];
        return val != null && String(val).toLowerCase().includes(q);
      })
    );
  }, [data, searchQuery, resolvedColumns]);

  // ── Sorted data ──
  const sortedData = useMemo(() => {
    if (!sortConfig.key) return filteredData;
    return [...filteredData].sort((a, b) => {
      const aVal = a[sortConfig.key];
      const bVal = b[sortConfig.key];
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      const comparison = typeof aVal === 'number'
        ? aVal - bVal
        : String(aVal).localeCompare(String(bVal));
      return sortConfig.direction === 'asc' ? comparison : -comparison;
    });
  }, [filteredData, sortConfig]);

  // ── Pagination ──
  const totalPages = Math.max(1, Math.ceil(sortedData.length / PAGE_SIZE));
  const paginatedData = useMemo(() => {
    const start = currentPage * PAGE_SIZE;
    return sortedData.slice(start, start + PAGE_SIZE);
  }, [sortedData, currentPage]);

  // Reset page when search changes
  useEffect(() => { setCurrentPage(0); }, [searchQuery]);

  // ── Sort handler ──
  const handleSort = useCallback((key) => {
    setSortConfig(prev => ({
      key,
      direction: prev.key === key && prev.direction === 'asc' ? 'desc' : 'asc',
    }));
  }, []);

  // ── Cell renderer ──
  const renderCell = useCallback((value, colKey) => {
    if (value == null) return <span className="text-text-muted/40">—</span>;

    const str = String(value);

    // Severity badges
    if (SEVERITY_COLORS[str.toUpperCase()]) {
      return (
        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-mono font-bold tracking-wider border ${SEVERITY_COLORS[str.toUpperCase()]}`}>
          {str}
        </span>
      );
    }

    // Trend indicators
    if (colKey === 'trend' && TREND_ICONS[str]) {
      const { icon: Icon, color } = TREND_ICONS[str];
      return (
        <span className={`flex items-center gap-1 ${color} text-xs font-mono`}>
          {Icon && <Icon className="w-3 h-3" />}
          {str}
        </span>
      );
    }

    // Confidence values (0-1)
    if (colKey === 'confidence' || colKey === 'probability') {
      const num = parseFloat(value);
      if (!isNaN(num) && num >= 0 && num <= 1) {
        const pct = Math.round(num * 100);
        const color = pct >= 80 ? 'text-green-400' : pct >= 50 ? 'text-amber-400' : 'text-red-400';
        return <span className={`${color} font-mono text-xs font-bold`}>{pct}%</span>;
      }
    }

    // Truncate long strings
    if (str.length > 80) {
      return <span className="text-text-secondary text-xs" title={str}>{str.substring(0, 80)}…</span>;
    }

    return <span className="text-text-primary text-xs font-mono">{str}</span>;
  }, []);

  return (
    <div className={`rounded-xl border border-obsidian-border bg-obsidian/80 backdrop-blur-md overflow-hidden ${className}`}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-obsidian-border bg-obsidian-light/50">
        <div className="flex items-center gap-2">
          <Grid3x3 className="w-4 h-4 text-cyber-purple" />
          <span className="text-xs font-mono font-bold text-text-primary tracking-wider">{title}</span>
          <span className="text-[10px] font-mono text-text-muted px-2 py-0.5 rounded-full bg-obsidian-mid border border-obsidian-border">
            {filteredData.length} rows
          </span>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-text-muted" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Filter…"
            className="pl-8 pr-3 py-1.5 rounded-lg bg-obsidian-mid border border-obsidian-border text-xs font-mono text-text-primary placeholder:text-text-muted/50 focus:border-cyber-purple/50 focus:outline-none transition-colors w-48"
          />
        </div>
      </div>

      {/* Table */}
      <div ref={tableRef} className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-obsidian-border bg-obsidian-mid/30">
              {resolvedColumns.map(col => (
                <th
                  key={col.key}
                  onClick={() => col.sortable !== false && handleSort(col.key)}
                  className={`px-3 py-2.5 text-left text-[10px] font-mono font-bold text-text-muted tracking-wider uppercase whitespace-nowrap ${
                    col.sortable !== false ? 'cursor-pointer hover:text-cyber-purple transition-colors select-none' : ''
                  }`}
                >
                  <span className="flex items-center gap-1">
                    {col.label}
                    {sortConfig.key === col.key && (
                      <ArrowUpDown className="w-3 h-3 text-cyber-purple" />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {paginatedData.length === 0 ? (
              <tr>
                <td colSpan={resolvedColumns.length} className="px-4 py-12 text-center">
                  <Database className="w-8 h-8 text-text-muted/30 mx-auto mb-2" />
                  <span className="text-xs font-mono text-text-muted">No data available</span>
                </td>
              </tr>
            ) : (
              paginatedData.map((row, rowIdx) => (
                <tr
                  key={rowIdx}
                  className="border-b border-obsidian-border/30 hover:bg-cyber-purple/5 transition-colors"
                >
                  {resolvedColumns.map(col => (
                    <td key={col.key} className="px-3 py-2 whitespace-nowrap">
                      {renderCell(row[col.key], col.key)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-obsidian-border bg-obsidian-light/30">
          <span className="text-[10px] font-mono text-text-muted">
            Page {currentPage + 1} of {totalPages}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setCurrentPage(p => Math.max(0, p - 1))}
              disabled={currentPage === 0}
              className="p-1 rounded hover:bg-obsidian-mid disabled:opacity-30 transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-3.5 h-3.5 text-text-secondary" />
            </button>
            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={currentPage >= totalPages - 1}
              className="p-1 rounded hover:bg-obsidian-mid disabled:opacity-30 transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-3.5 h-3.5 text-text-secondary" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
});

export default DataGrid;
