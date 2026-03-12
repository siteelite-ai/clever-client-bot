import * as pdfjsLib from 'pdfjs-dist';

// Use the bundled worker matching the installed package version
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

interface TextItem {
  str: string;
  transform: number[]; // [scaleX, skewX, skewY, scaleY, translateX, translateY]
  width: number;
  height: number;
}

interface TableRow {
  y: number;
  cells: { x: number; text: string }[];
}

/**
 * Extract text from PDF with coordinate-based table reconstruction.
 * Groups text items by Y position into rows, then sorts by X within each row.
 */
export async function extractTextFromPdf(file: File): Promise<{ title: string; content: string }> {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  
  const totalPages = pdf.numPages;
  const textParts: string[] = [];

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const viewport = page.getViewport({ scale: 1.0 });
    
    // Collect all text items with their positions
    const items: TextItem[] = textContent.items
      .filter((item: any) => item.str && item.str.trim())
      .map((item: any) => ({
        str: item.str,
        transform: item.transform,
        width: item.width,
        height: item.height || Math.abs(item.transform[3]),
      }));

    if (items.length === 0) continue;

    // Detect if this page likely contains a table by analyzing X-position clustering
    const pageText = extractWithCoordinates(items, viewport.height);
    if (pageText.trim()) {
      textParts.push(pageText);
    }
  }

  const fullText = textParts.join('\n\n');
  const title = file.name.replace(/\.pdf$/i, '');

  return { title, content: fullText };
}

/**
 * Extract text preserving spatial layout using X/Y coordinates.
 * Groups items into rows by Y position, then reconstructs table structure.
 */
function extractWithCoordinates(items: TextItem[], pageHeight: number): string {
  // PDF coordinates: origin at bottom-left, Y increases upward
  // We need to flip Y so top = 0
  const positioned = items.map(item => ({
    text: item.str,
    x: Math.round(item.transform[4]),
    y: Math.round(pageHeight - item.transform[5]), // flip Y
    fontSize: Math.abs(item.transform[3]),
    width: item.width,
  }));

  // Sort by Y (top to bottom), then X (left to right)
  positioned.sort((a, b) => a.y - b.y || a.x - b.x);

  // Group items into rows based on Y proximity
  // Items within ~60% of font height are considered same row
  const rows: TableRow[] = [];
  let currentRow: TableRow | null = null;

  for (const item of positioned) {
    const threshold = Math.max(item.fontSize * 0.6, 3);
    
    if (!currentRow || Math.abs(item.y - currentRow.y) > threshold) {
      // New row
      currentRow = { y: item.y, cells: [] };
      rows.push(currentRow);
    }
    
    currentRow.cells.push({ x: item.x, text: item.text });
  }

  // Detect table-like structure: multiple rows with similar column positions
  const isTable = detectTableStructure(rows);

  if (isTable) {
    return formatAsTable(rows);
  } else {
    return formatAsText(rows);
  }
}

/**
 * Detect if rows form a table by checking if X positions cluster into columns.
 */
function detectTableStructure(rows: TableRow[]): boolean {
  // Need at least 3 rows with 2+ cells to consider it a table
  const multiCellRows = rows.filter(r => r.cells.length >= 2);
  if (multiCellRows.length < 3) return false;

  // Check if X positions form consistent columns
  // Collect all unique X positions (rounded to nearest 10px)
  const xPositions = new Map<number, number>(); // rounded X → count
  for (const row of multiCellRows) {
    for (const cell of row.cells) {
      const rounded = Math.round(cell.x / 10) * 10;
      xPositions.set(rounded, (xPositions.get(rounded) || 0) + 1);
    }
  }

  // If we have consistent columns (positions appearing in >30% of rows), it's a table
  const threshold = multiCellRows.length * 0.3;
  const columnCount = Array.from(xPositions.values()).filter(count => count >= threshold).length;
  
  return columnCount >= 2;
}

/**
 * Format rows as a structured table with column alignment.
 */
function formatAsTable(rows: TableRow[]): string {
  // Find column positions by clustering X values
  const allX: number[] = [];
  for (const row of rows) {
    for (const cell of row.cells) {
      allX.push(cell.x);
    }
  }
  
  // Cluster X positions into columns (within 15px tolerance)
  const sortedX = [...new Set(allX)].sort((a, b) => a - b);
  const columns: number[] = [];
  for (const x of sortedX) {
    const nearestCol = columns.find(c => Math.abs(c - x) < 15);
    if (!nearestCol) {
      columns.push(x);
    }
  }
  columns.sort((a, b) => a - b);

  // Build table rows: assign each cell to nearest column
  const tableRows: string[][] = [];
  for (const row of rows) {
    const tableRow: string[] = new Array(columns.length).fill('');
    
    for (const cell of row.cells) {
      // Find nearest column
      let nearestIdx = 0;
      let minDist = Infinity;
      for (let i = 0; i < columns.length; i++) {
        const dist = Math.abs(columns[i] - cell.x);
        if (dist < minDist) {
          minDist = dist;
          nearestIdx = i;
        }
      }
      
      // Append to cell (in case multiple items map to same column)
      if (tableRow[nearestIdx]) {
        tableRow[nearestIdx] += ' ' + cell.text;
      } else {
        tableRow[nearestIdx] = cell.text;
      }
    }
    
    tableRows.push(tableRow);
  }

  // Format as markdown-style table
  if (tableRows.length === 0) return '';

  // Calculate column widths
  const colWidths = columns.map((_, i) => 
    Math.max(...tableRows.map(row => (row[i] || '').length), 3)
  );

  const lines: string[] = [];
  for (let i = 0; i < tableRows.length; i++) {
    const row = tableRows[i];
    const formatted = row.map((cell, j) => (cell || '').padEnd(colWidths[j])).join(' | ');
    lines.push(formatted.trim());
    
    // Add separator after first row (header)
    if (i === 0) {
      const separator = colWidths.map(w => '-'.repeat(w)).join(' | ');
      lines.push(separator);
    }
  }

  return lines.join('\n');
}

/**
 * Format rows as regular text, joining cells within each row.
 */
function formatAsText(rows: TableRow[]): string {
  const lines: string[] = [];
  
  for (const row of rows) {
    // Sort cells by X position
    row.cells.sort((a, b) => a.x - b.x);
    
    // Check gaps between cells to add appropriate spacing
    let lineText = '';
    for (let i = 0; i < row.cells.length; i++) {
      const cell = row.cells[i];
      if (i > 0) {
        const prevCell = row.cells[i - 1];
        const gap = cell.x - prevCell.x;
        // Large gap suggests separate columns/sections
        lineText += gap > 50 ? '  ' : ' ';
      }
      lineText += cell.text;
    }
    
    lines.push(lineText.trim());
  }

  return lines.join('\n');
}
