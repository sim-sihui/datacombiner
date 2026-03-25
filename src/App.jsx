import { useState, useCallback, useRef, useEffect } from "react";
import * as XLSX from "xlsx";

// ── helpers ──────────────────────────────────────────────────────────────────

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length) return { headers: [], rows: [] };
  const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
  const rows = lines.slice(1).map((line) => {
    const vals = [];
    let cur = "", inQ = false;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '"') { inQ = !inQ; continue; }
      if (line[i] === "," && !inQ) { vals.push(cur.trim()); cur = ""; continue; }
      cur += line[i];
    }
    vals.push(cur.trim());
    return Object.fromEntries(headers.map((h, i) => [h, vals[i] ?? ""]));
  });
  return { headers, rows };
}

function parseXLSX(buffer) {
  const wb = XLSX.read(buffer, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { defval: "" });
  const headers = data.length ? Object.keys(data[0]) : [];
  return { headers, rows: data };
}

function applyFilters(rows, filters) {
  return rows.filter((row) =>
    Object.entries(filters).every(([col, val]) =>
      !val || String(row[col] ?? "").toLowerCase().includes(val.toLowerCase())
    )
  );
}

function exportCSV(rows, headers, filename) {
  const escape = (v) => {
    const s = String(v ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n")
      ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(escape).join(","), ...rows.map((row) => headers.map((h) => escape(row[h])).join(","))];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

function exportXLSX(rows, headers, filename) {
  const ws = XLSX.utils.json_to_sheet(rows.map(r => Object.fromEntries(headers.map(h => [h, r[h] ?? ""]))));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  XLSX.writeFile(wb, filename);
}

function downloadText(content, filename, mime = "text/plain") {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Format converter definitions ──────────────────────────────────────────────

const FORMATS = [
  { id: "pdf",   label: "PDF",          icon: "📕", ext: ".pdf",  accept: ".pdf,application/pdf",               color: "#e74c3c" },
  { id: "word",  label: "Word (DOCX)",  icon: "📘", ext: ".docx", accept: ".doc,.docx,application/msword",       color: "#2b579a" },
  { id: "excel", label: "Excel (XLSX)", icon: "📗", ext: ".xlsx", accept: ".xls,.xlsx",                          color: "#217346" },
  { id: "csv",   label: "CSV",          icon: "📊", ext: ".csv",  accept: ".csv,text/csv",                       color: "#4CAF50" },
  { id: "pptx",  label: "PowerPoint",   icon: "📙", ext: ".pptx", accept: ".ppt,.pptx",                          color: "#d04a00" },
  { id: "txt",   label: "Plain Text",   icon: "📄", ext: ".txt",  accept: ".txt,text/plain",                     color: "#c8a87a" },
  { id: "json",  label: "JSON",         icon: "🗂️",  ext: ".json", accept: ".json,application/json",              color: "#e67e22" },
  { id: "html",  label: "HTML",         icon: "🌐", ext: ".html", accept: ".html,.htm,text/html",                color: "#9b59b6" },
  { id: "md",    label: "Markdown",     icon: "✍️",  ext: ".md",   accept: ".md,.markdown,text/markdown",         color: "#1abc9c" },
];

const AI_CONVERSIONS = new Set([
  "pdf→word","pdf→csv","pdf→excel","pdf→txt","pdf→json","pdf→html","pdf→md",
  "word→csv","word→excel","word→txt","word→json","word→html","word→md","word→pdf",
  "excel→csv","excel→txt","excel→json","excel→html","excel→md","excel→word","excel→pdf",
  "csv→excel","csv→txt","csv→json","csv→html","csv→md",
  "txt→csv","txt→json","txt→html","txt→md",
  "html→txt","html→md","html→csv","html→json",
  "md→html","md→txt","md→csv","md→json",
  "json→csv","json→txt","json→html","json→md",
  "pptx→txt","pptx→md","pptx→html",
]);

function getConversionKey(from, to) { return `${from}→${to}`; }

function getConversionPrompt(fromId, toId) {
  const k = getConversionKey(fromId, toId);
  const map = {
    "pdf→csv":    "Extract ALL tables from this document. Return ONLY valid CSV with headers on the first row. Separate multiple tables with a blank line. No markdown, no explanation.",
    "pdf→excel":  "Extract ALL tables from this document. Return ONLY a JSON array of row objects with column headers as keys. No markdown, no code fences.",
    "pdf→word":   "Convert this document to well-structured text. Use '# ' for headings, '## ' for subheadings, '- ' for bullet points. Full content, no commentary.",
    "pdf→txt":    "Extract all text exactly as it appears. Return only raw text, no commentary.",
    "pdf→json":   "Extract all structured data (tables, key-value pairs, lists, metadata). Return ONLY valid JSON. No code fences.",
    "pdf→html":   "Convert to clean semantic HTML using h1/h2, p, ul/li, table tags. Return only the HTML body content.",
    "pdf→md":     "Convert to clean Markdown preserving headings, lists, tables. Return only Markdown.",
    "word→csv":   "Extract all tables. Return ONLY valid CSV with headers. No markdown.",
    "word→excel": "Extract all tables. Return ONLY a JSON array of row objects. No code fences.",
    "word→txt":   "Extract all text as plain text. No commentary.",
    "word→json":  "Extract all structured data. Return ONLY valid JSON. No code fences.",
    "word→html":  "Convert to clean semantic HTML. Return only the HTML body content.",
    "word→md":    "Convert to clean Markdown preserving structure. Return only Markdown.",
    "word→pdf":   "Format all content as clean, well-structured HTML representing the document layout.",
    "excel→csv":  "Convert this spreadsheet to CSV. Return ONLY valid CSV with headers. No explanation.",
    "excel→txt":  "Extract all data as tab-separated plain text. Return only the text.",
    "excel→json": "Convert to JSON. Return ONLY a JSON array of row objects with column headers as keys. No code fences.",
    "excel→html": "Convert to an HTML table. Return only the complete HTML table element.",
    "excel→md":   "Convert to a Markdown table. Return only the Markdown table.",
    "excel→word": "Convert this spreadsheet into a well-structured Word document format. Create a professional report: start with a title heading '# Spreadsheet Report', add a brief summary paragraph describing the data, then present each section of data as a formatted table using Markdown table syntax, with column headers and aligned rows. Add section headings where logical. Return clean Markdown that Microsoft Word can import.",
    "excel→pdf":  "Convert this spreadsheet into a complete, print-ready HTML document. Include: a proper <!DOCTYPE html> with <head> containing <style> for professional print formatting (clean sans-serif font, styled tables with borders, alternating row colors #f9f9f9, a header section with the title, page margins). Present all data in styled HTML tables with <thead> and <tbody>. Make it look like a polished PDF report. Return the complete HTML document.",
    "csv→excel":  "Parse this CSV. Return ONLY a JSON array of row objects with headers as keys. No code fences.",
    "csv→txt":    "Convert this CSV to readable plain text. Return only the formatted text.",
    "csv→json":   "Convert CSV to JSON. Return ONLY a JSON array of row objects. No code fences.",
    "csv→html":   "Convert to an HTML table. Return only the complete HTML table element.",
    "csv→md":     "Convert to a Markdown table. Return only the Markdown table.",
    "txt→csv":    "Detect structure and convert to CSV. Return ONLY valid CSV with headers.",
    "txt→json":   "Parse and extract structured data. Return ONLY valid JSON. No code fences.",
    "txt→html":   "Convert to semantic HTML. Return only the HTML body content.",
    "txt→md":     "Convert to Markdown adding appropriate formatting. Return only Markdown.",
    "html→txt":   "Strip all HTML tags and return only clean plain text.",
    "html→md":    "Convert HTML to clean Markdown. Return only Markdown.",
    "html→csv":   "Extract all HTML tables and convert to CSV. Return only CSV.",
    "html→json":  "Extract structured data from HTML. Return ONLY valid JSON. No code fences.",
    "md→html":    "Convert Markdown to semantic HTML. Return only the HTML body content.",
    "md→txt":     "Strip Markdown formatting and return plain text.",
    "md→csv":     "Extract Markdown tables and convert to CSV. Return only CSV.",
    "md→json":    "Extract structured data from Markdown. Return ONLY valid JSON. No code fences.",
    "json→csv":   "Convert JSON array to CSV. Return ONLY valid CSV with headers.",
    "json→txt":   "Convert JSON to human-readable plain text. Return only the text.",
    "json→html":  "Convert JSON to formatted HTML. Return only the HTML body content.",
    "json→md":    "Convert JSON to readable Markdown. Return only Markdown.",
    "pptx→txt":   "Extract all text slide by slide, labelling each slide. Return only text.",
    "pptx→md":    "Convert presentation to Markdown with each slide as a section. Return only Markdown.",
    "pptx→html":  "Convert presentation to HTML with each slide as a section. Return only HTML body content.",
  };
  return map[k] || `Convert the content of this ${fromId.toUpperCase()} file to ${toId.toUpperCase()} format. Return only the converted content, no explanation.`;
}

// ── sub-components ────────────────────────────────────────────────────────────

function DropZone({ label, onFiles, accept, multiple = false, compact = false }) {
  const [over, setOver] = useState(false);
  const inputRef = useRef();
  const handle = useCallback((files) => { if (files.length) onFiles([...files]); }, [onFiles]);

  return (
    <div
      className={`drop-zone ${over ? "over" : ""} ${compact ? "compact" : ""}`}
      onDragOver={(e) => { e.preventDefault(); setOver(true); }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); handle(e.dataTransfer.files); }}
      onClick={() => inputRef.current.click()}
    >
      <input ref={inputRef} type="file" accept={accept} multiple={multiple}
        style={{ display: "none" }} onChange={(e) => handle(e.target.files)} />
      <div className="drop-icon">{compact ? "📂" : "⬆"}</div>
      <div className="drop-label">{label}</div>
      {!compact && <div className="drop-sub">drag & drop or click to browse</div>}
    </div>
  );
}

function FilterBar({ headers, filters, onChange }) {
  return (
    <div className="filter-bar">
      {headers.map((h) => (
        <div key={h} className="filter-item">
          <label>{h}</label>
          <input placeholder={`filter ${h}…`} value={filters[h] ?? ""}
            onChange={(e) => onChange({ ...filters, [h]: e.target.value })} />
        </div>
      ))}
    </div>
  );
}

function DataTable({ headers, rows, caption }) {
  return (
    <div className="table-wrap">
      {caption && <div className="table-caption">{caption}</div>}
      <div className="table-scroll">
        <table>
          <thead><tr>{headers.map((h) => <th key={h}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.length === 0
              ? <tr><td colSpan={headers.length} className="empty">no rows match</td></tr>
              : rows.map((row, i) => (
                  <tr key={i}>{headers.map((h) => <td key={h}>{row[h] ?? ""}</td>)}</tr>
                ))
            }
          </tbody>
        </table>
      </div>
      <div className="row-count">{rows.length} rows</div>
    </div>
  );
}

// ── Format Converter ─────────────────────────────────────────────────────────

function FormatConverter() {
  const [fromId, setFromId] = useState("pdf");
  const [toId, setToId]     = useState("csv");
  const [file, setFile]     = useState(null);
  const [status, setStatus] = useState("idle");
  const [result, setResult] = useState(null);
  const [errorMsg, setErrorMsg]         = useState("");
  const [previewRows, setPreviewRows]   = useState([]);
  const [previewHeaders, setPreviewHeaders] = useState([]);

  const fromFmt = FORMATS.find(f => f.id === fromId);
  const toFmt   = FORMATS.find(f => f.id === toId);
  const key     = getConversionKey(fromId, toId);
  const isAI    = AI_CONVERSIONS.has(key);

  const resetState = () => {
    setFile(null); setStatus("idle"); setResult(null);
    setErrorMsg(""); setPreviewRows([]); setPreviewHeaders([]);
  };

  const handleFromChange = (id) => {
    setFromId(id);
    if (id === toId) setToId(FORMATS.find(f => f.id !== id)?.id || "csv");
    resetState();
  };
  const handleToChange = (id) => { setToId(id); resetState(); };

  const handleFile = (files) => {
    setFile(files[0]);
    setStatus("idle"); setResult(null); setErrorMsg("");
    setPreviewRows([]); setPreviewHeaders([]);
  };

  const readFileContent = (f) => new Promise((res, rej) => {
    const binaryExts = ["pdf","doc","docx","xls","xlsx","ppt","pptx"];
    const ext = f.name.split(".").pop().toLowerCase();
    if (binaryExts.includes(ext)) {
      const r = new FileReader();
      r.onload = (e) => res({ type: "base64", data: e.target.result.split(",")[1], ext });
      r.onerror = rej;
      r.readAsDataURL(f);
    } else {
      const r = new FileReader();
      r.onload = (e) => res({ type: "text", data: e.target.result, ext });
      r.onerror = rej;
      r.readAsText(f);
    }
  });

  const buildContent = async (f) => {
    const { type, data, ext } = await readFileContent(f);
    const prompt = getConversionPrompt(fromId, toId);

    // PDF: use native document type
    if (type === "base64" && ext === "pdf") {
      return [
        { type: "document", source: { type: "base64", media_type: "application/pdf", data } },
        { type: "text", text: prompt }
      ];
    }

    // Excel/XLS: parse with SheetJS and send as CSV text so Claude can read it properly
    if (["xls","xlsx"].includes(ext) && type === "base64") {
      try {
        const binary = atob(data);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const wb = XLSX.read(bytes, { type: "array" });
        // Collect all sheets as CSV blocks
        const sheetsText = wb.SheetNames.map(name => {
          const ws = wb.Sheets[name];
          const csv = XLSX.utils.sheet_to_csv(ws);
          return `=== Sheet: ${name} ===\n${csv}`;
        }).join("\n\n");
        return [{ type: "text", text: `File: "${f.name}" (Excel spreadsheet)\n\nExtracted data:\n${sheetsText}\n\n${prompt}` }];
      } catch (e) {
        // Fallback if parse fails
        return [{ type: "text", text: `File: "${f.name}" (Excel spreadsheet - could not parse). ${prompt}` }];
      }
    }

    // Plain text files (csv, txt, json, html, md)
    if (type === "text") {
      return [{ type: "text", text: `File: "${f.name}"\n\nContent:\n${data}\n\n${prompt}` }];
    }

    // Other binary (docx, pptx etc.) — send as base64 with description
    return [{ type: "text", text: `File: "${f.name}" (${ext.toUpperCase()} binary format). ${prompt}` }];
  };

  const handleConvert = async () => {
    if (!file) return;
    setStatus("loading"); setResult(null); setErrorMsg(""); setPreviewRows([]); setPreviewHeaders([]);

    if (!isAI) {
      setStatus("error");
      setErrorMsg(`${fromFmt.label} → ${toFmt.label} conversion requires server-side processing. Please use ilovepdf.com, smallpdf.com, or Adobe Acrobat Online.`);
      return;
    }

    try {
      const content = await buildContent(file);
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 1000,
          messages: [{ role: "user", content }]
        })
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error.message);
      const text = data.content.map(c => c.text || "").join("").trim();
      const clean = text.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
      setResult(clean);

      if (toId === "csv") {
        const parsed = parseCSV(clean);
        if (parsed.headers.length) { setPreviewHeaders(parsed.headers); setPreviewRows(parsed.rows.slice(0, 50)); }
      } else if (toId === "excel" || toId === "json") {
        try {
          const parsed = JSON.parse(clean);
          if (Array.isArray(parsed) && parsed.length) {
            setPreviewHeaders(Object.keys(parsed[0]));
            setPreviewRows(parsed.slice(0, 50));
          }
        } catch {}
      }
      setStatus("done");
    } catch(e) {
      setStatus("error");
      setErrorMsg(e.message || "Conversion failed. Please try again.");
    }
  };

  const handleDownload = () => {
    const base = file?.name.replace(/\.[^.]+$/, "") || "converted";
    if (toId === "csv")   { downloadText(result, `${base}.csv`, "text/csv"); return; }
    if (toId === "json")  { downloadText(result, `${base}.json`, "application/json"); return; }
    if (toId === "md")    { downloadText(result, `${base}.md`, "text/markdown"); return; }
    if (toId === "txt")   { downloadText(result, `${base}.txt`, "text/plain"); return; }
    if (toId === "word")  { downloadText(result, `${base}.md`, "text/markdown"); return; } // Word can open MD, or user prints
    if (toId === "pdf")   { downloadText(result, `${base}_printable.html`, "text/html"); return; } // Open in browser → Print → Save as PDF
    if (toId === "html")  { downloadText(result, `${base}.html`, "text/html"); return; }
    if (toId === "excel") {
      try {
        const parsed = JSON.parse(result);
        if (Array.isArray(parsed) && parsed.length) { exportXLSX(parsed, Object.keys(parsed[0]), `${base}.xlsx`); return; }
      } catch {}
    }
    downloadText(result, `${base}${toFmt.ext}`, "text/plain");
  };

  // For PDF output: open the HTML in a new tab so user can Ctrl+P → Save as PDF
  const handlePrintPreview = () => {
    const win = window.open("", "_blank");
    win.document.write(result);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 800);
  };

  const availableTo = FORMATS.filter(f => f.id !== fromId);

  return (
    <div className="converter-wrap">
      <div className="converter-picker">
        <div className="picker-col">
          <div className="picker-label">Convert FROM</div>
          <div className="format-grid">
            {FORMATS.map(f => (
              <button key={f.id}
                className={`fmt-btn ${fromId === f.id ? "active" : ""}`}
                style={fromId === f.id ? { borderColor: f.color, background: f.color + "18", color: f.color } : {}}
                onClick={() => handleFromChange(f.id)}>
                <span className="fmt-icon">{f.icon}</span>
                <span className="fmt-name">{f.label}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="picker-arrow">
          <div className="arrow-glyph">→</div>
        </div>

        <div className="picker-col">
          <div className="picker-label">Convert TO</div>
          <div className="format-grid">
            {availableTo.map(f => {
              const supported = AI_CONVERSIONS.has(getConversionKey(fromId, f.id));
              return (
                <button key={f.id}
                  className={`fmt-btn ${toId === f.id ? "active" : ""} ${!supported ? "external" : ""}`}
                  style={toId === f.id ? { borderColor: f.color, background: f.color + "18", color: f.color } : {}}
                  onClick={() => handleToChange(f.id)}
                  title={!supported ? "Requires external tool" : ""}>
                  <span className="fmt-icon">{f.icon}</span>
                  <span className="fmt-name">{f.label}</span>
                  {!supported && <span className="fmt-ext-badge">ext</span>}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div className="conversion-summary" style={{ borderColor: fromFmt.color + "55" }}>
        <span style={{ color: fromFmt.color }}>{fromFmt.icon} {fromFmt.label}</span>
        <span className="summary-arrow">→</span>
        <span style={{ color: toFmt.color }}>{toFmt.icon} {toFmt.label}</span>
        <span className={`summary-badge ${isAI ? "ai" : "ext"}`}>{isAI ? "⚡ AI-powered" : "🔗 External tool needed"}</span>
      </div>

      <DropZone label={`Drop your ${fromFmt.label} file here`} accept={fromFmt.accept} onFiles={handleFile} />

      {file && (
        <div className="file-chips" style={{ marginBottom: "1rem" }}>
          <span className="chip">
            <span className="chip-type" style={{ background: fromFmt.color + "33", color: fromFmt.color }}>{fromFmt.id.toUpperCase()}</span>
            {file.name}
          </span>
        </div>
      )}

      <button className="convert-btn" disabled={!file || status === "loading"} onClick={handleConvert}>
        {status === "loading"
          ? <><span className="spinner">⟳</span> Converting…</>
          : `Convert ${fromFmt.label} → ${toFmt.label}`}
      </button>

      {status === "error" && (
        <div className="error-box">
          ⚠ {errorMsg}
          {!isAI && (
            <div className="error-links">
              <a href="https://ilovepdf.com" target="_blank" rel="noopener noreferrer">ilovepdf.com</a>
              <a href="https://smallpdf.com" target="_blank" rel="noopener noreferrer">smallpdf.com</a>
              <a href="https://adobe.com/acrobat/online" target="_blank" rel="noopener noreferrer">Adobe Acrobat</a>
            </div>
          )}
        </div>
      )}

      {status === "done" && result && (
        <div className="result-section">
          <div className="result-header">
            <span className="result-ok">✓ Conversion complete</span>
            <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
              {toId === "pdf" && (
                <button className="export-btn secondary" onClick={handlePrintPreview}>🖨 Open & Print as PDF</button>
              )}
              <button className="export-btn" onClick={handleDownload}>
                ↓ {toId === "word" ? "Download .md (open in Word)" : toId === "pdf" ? "Download HTML file" : `Download ${toFmt.label} (${toFmt.ext})`}
              </button>
            </div>
          </div>

          {toId === "word" && (
            <div className="conversion-note">
              💡 <strong>How to open in Word:</strong> Download the .md file, then in Microsoft Word go to <em>File → Open</em> and select it — Word will import the formatted document. Alternatively, paste the text below directly into a new Word doc.
            </div>
          )}
          {toId === "pdf" && (
            <div className="conversion-note">
              💡 <strong>How to save as PDF:</strong> Click "Open & Print as PDF" above, then in the print dialog choose <em>Save as PDF</em> (or press Ctrl+P and select PDF printer). Or download the HTML file and open it in any browser to print.
            </div>
          )}

          {previewHeaders.length > 0 && (
            <>
              <div className="section-title" style={{ marginTop: "1rem" }}>Preview (first 50 rows)</div>
              <DataTable headers={previewHeaders} rows={previewRows} caption="" />
            </>
          )}
          {["txt","word","md"].includes(toId) && previewHeaders.length === 0 && (
            <div className="text-preview">{result}</div>
          )}
          {toId === "pdf" && (
            <div className="html-preview" dangerouslySetInnerHTML={{ __html: result }} />
          )}
          {toId === "html" && previewHeaders.length === 0 && (
            <div className="html-preview" dangerouslySetInnerHTML={{ __html: result }} />
          )}
          {toId === "json" && previewHeaders.length === 0 && (
            <pre className="json-preview">{result}</pre>
          )}
        </div>
      )}
    </div>
  );
}

// ── helpers: parse any file (CSV or XLS/XLSX) by extension ───────────────────

function parseAnyFile(file) {
  return new Promise((res) => {
    const ext = file.name.split(".").pop().toLowerCase();
    if (ext === "csv") {
      const r = new FileReader();
      r.onload = (e) => res({ name: file.name, ...parseCSV(e.target.result) });
      r.readAsText(file);
    } else {
      const r = new FileReader();
      r.onload = (e) => res({ name: file.name, ...parseXLSX(new Uint8Array(e.target.result)) });
      r.readAsArrayBuffer(file);
    }
  });
}

// ── TableSlot: one "side" of the join ────────────────────────────────────────

function TableSlot({ label, color, files, headers, rows, filters, onFiles, onFilterChange, onClear }) {
  const filteredRows = applyFilters(rows, filters);
  return (
    <div className="slot">
      <div className="slot-header">
        <div className="slot-dot" style={{ background: color }} />
        <span className="slot-label">{label}</span>
        {files.length > 0 && (
          <button className="slot-clear" onClick={onClear} title="Clear all files">✕ clear</button>
        )}
      </div>

      <DropZone
        label={files.length ? "Drop more files to append" : "Drop CSV or XLS/XLSX files here"}
        accept=".csv,.xls,.xlsx,text/csv"
        multiple
        onFiles={onFiles}
        compact={files.length > 0}
      />

      {files.length > 0 && (
        <div className="file-chips">
          {files.map((f, i) => (
            <span key={i} className="chip">
              <span className="chip-type" style={{ background: color + "33", color }}>{f.split(".").pop().toUpperCase()}</span>
              {f}
            </span>
          ))}
        </div>
      )}

      {headers.length > 0 && (
        <>
          <div className="slot-meta">{headers.length} columns · {rows.length} rows total</div>
          <FilterBar headers={headers} filters={filters} onChange={onFilterChange} />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.5rem", marginBottom: "0.75rem" }}>
            <button className="export-btn" onClick={() => exportCSV(filteredRows, headers, "table_filtered.csv")}>↓ CSV ({filteredRows.length})</button>
            <button className="export-btn secondary" onClick={() => exportXLSX(filteredRows, headers, "table_filtered.xlsx")}>↓ XLSX ({filteredRows.length})</button>
          </div>
          <DataTable headers={headers} rows={filteredRows} caption={`${filteredRows.length} / ${rows.length} rows`} />
        </>
      )}

      {!headers.length && (
        <div className="placeholder" style={{ padding: "2rem" }}>
          Upload files to populate {label}
        </div>
      )}
    </div>
  );
}

// ── DataFuse ──────────────────────────────────────────────────────────────────

function DataFuse() {
  // Table A
  const [aHeaders, setAHeaders] = useState([]);
  const [aRows, setARows]       = useState([]);
  const [aFiles, setAFiles]     = useState([]);
  const [aFilters, setAFilters] = useState({});

  // Table B
  const [bHeaders, setBHeaders] = useState([]);
  const [bRows, setBRows]       = useState([]);
  const [bFiles, setBFiles]     = useState([]);
  const [bFilters, setBFilters] = useState({});

  // Join config
  const [joinColA, setJoinColA]         = useState("");
  const [joinColB, setJoinColB]         = useState("");
  const [joinType, setJoinType]         = useState("left"); // left | inner | full
  const [merged, setMerged]             = useState(null);
  const [mergedHeaders, setMergedHeaders] = useState([]);
  const [mergedFilters, setMergedFilters] = useState({});

  const [tab, setTab] = useState("tables"); // tables | join

  // Load files into a slot — merges columns (union), appends rows
  const loadFiles = useCallback((files, setHeaders, setRows, setFileNames, setFilters, setJoinCol, currentJoinCol) => {
    Promise.all(files.map(parseAnyFile)).then((results) => {
      setHeaders((prevH) => {
        const allH = [...prevH];
        results.forEach(({ headers }) => headers.forEach(h => { if (!allH.includes(h)) allH.push(h); }));
        if (!currentJoinCol && allH.length) setJoinCol(allH[0]);
        return allH;
      });
      setRows((prev) => {
        let next = [...prev];
        results.forEach(({ rows }) => { next = next.concat(rows); });
        return next;
      });
      setFileNames((prev) => [...prev, ...files.map(f => f.name)]);
      setFilters({});
    });
  }, []);

  const handleAFiles = useCallback((files) => {
    loadFiles(files, setAHeaders, setARows, setAFiles, setAFilters, setJoinColA, joinColA);
  }, [loadFiles, joinColA]);

  const handleBFiles = useCallback((files) => {
    loadFiles(files, setBHeaders, setBRows, setBFiles, setBFilters, setJoinColB, joinColB);
  }, [loadFiles, joinColB]);

  const clearA = () => { setAHeaders([]); setARows([]); setAFiles([]); setAFilters({}); setJoinColA(""); setMerged(null); };
  const clearB = () => { setBHeaders([]); setBRows([]); setBFiles([]); setBFilters({}); setJoinColB(""); setMerged(null); };

  // Auto-detect a shared column name when both sides are loaded
  const sharedCols = aHeaders.filter(h => bHeaders.includes(h));

  const handleJoin = () => {
    if (!joinColA || !joinColB) return;

    // All unique headers from both sides, prefixing B-only columns with "B_" if they clash with A
    const bOnlyHeaders = bHeaders.filter(h => h !== joinColB && !aHeaders.includes(h));
    const bClashHeaders = bHeaders.filter(h => h !== joinColB && aHeaders.includes(h) && h !== joinColA);
    const allHeaders = [
      ...aHeaders,
      ...bOnlyHeaders,
      ...bClashHeaders.map(h => `B_${h}`),
    ];

    // Index B rows by join key
    const bMap = new Map();
    bRows.forEach((row) => {
      const key = String(row[joinColB] ?? "").toLowerCase().trim();
      if (!bMap.has(key)) bMap.set(key, []);
      bMap.get(key).push(row);
    });

    const result = [];

    // Left / inner: iterate A rows
    aRows.forEach((aRow) => {
      const key = String(aRow[joinColA] ?? "").toLowerCase().trim();
      const bMatches = bMap.get(key) || [];

      if (bMatches.length === 0) {
        if (joinType !== "inner") {
          result.push({ ...aRow, _status: "A only", ...Object.fromEntries(bOnlyHeaders.map(h => [h, ""])), ...Object.fromEntries(bClashHeaders.map(h => [`B_${h}`, ""])) });
        }
      } else {
        bMatches.forEach((bRow) => {
          result.push({
            ...aRow,
            ...Object.fromEntries(bOnlyHeaders.map(h => [h, bRow[h] ?? ""])),
            ...Object.fromEntries(bClashHeaders.map(h => [`B_${h}`, bRow[h] ?? ""])),
            _status: "✓ matched",
          });
        });
        bMap.delete(key); // mark as used
      }
    });

    // Full outer: add unmatched B rows
    if (joinType === "full") {
      bMap.forEach((bMatches) => {
        bMatches.forEach((bRow) => {
          result.push({
            ...Object.fromEntries(aHeaders.map(h => [h, ""])),
            ...Object.fromEntries(bOnlyHeaders.map(h => [h, bRow[h] ?? ""])),
            ...Object.fromEntries(bClashHeaders.map(h => [`B_${h}`, bRow[h] ?? ""])),
            [joinColA]: bRow[joinColB] ?? "",
            _status: "B only",
          });
        });
      });
    }

    setMergedHeaders(allHeaders);
    setMerged(result);
    setMergedFilters({});
    setTab("join");
  };

  const filteredMerged = merged ? applyFilters(merged, mergedFilters) : [];

  // Try to auto-suggest join columns when a shared col is detected
  useEffect(() => {
    if (sharedCols.length > 0 && !joinColA && !joinColB) {
      setJoinColA(sharedCols[0]);
      setJoinColB(sharedCols[0]);
    }
  }, [sharedCols.join(","), joinColA, joinColB]);

  return (
    <div>
      {/* ── tabs ── */}
      <div className="tabs">
        <button className={`tab-btn ${tab === "tables" ? "active" : ""}`} onClick={() => setTab("tables")}>
          Tables {aFiles.length || bFiles.length ? `(A:${aFiles.length} B:${bFiles.length})` : ""}
        </button>
        <button className={`tab-btn ${tab === "join" ? "active" : ""}`} onClick={() => setTab("join")}>
          Join Result {merged ? `(${merged.length})` : ""}
        </button>
      </div>

      {tab === "tables" && (
        <div className="panel">
          {/* ── two-column slot layout ── */}
          <div className="slots-grid">
            <TableSlot
              label="Table A"
              color="#c8a87a"
              files={aFiles}
              headers={aHeaders}
              rows={aRows}
              filters={aFilters}
              onFiles={handleAFiles}
              onFilterChange={setAFilters}
              onClear={clearA}
            />
            <TableSlot
              label="Table B"
              color="#7ac8c0"
              files={bFiles}
              headers={bHeaders}
              rows={bRows}
              filters={bFilters}
              onFiles={handleBFiles}
              onFilterChange={setBFilters}
              onClear={clearB}
            />
          </div>

          {/* ── join config ── */}
          {(aHeaders.length > 0 || bHeaders.length > 0) && (
            <div className="join-config-panel">
              <div className="join-config-title">
                <span>⚡ Configure Join</span>
                {sharedCols.length > 0 && (
                  <span className="shared-hint">
                    Shared columns detected: {sharedCols.map(h => <span key={h} className="shared-col">{h}</span>)}
                  </span>
                )}
              </div>
              <div className="join-config-row">
                <div className="join-field">
                  <label>Table A join column</label>
                  <select value={joinColA} onChange={e => setJoinColA(e.target.value)}>
                    <option value="">— select —</option>
                    {aHeaders.map(h => <option key={h}>{h}</option>)}
                  </select>
                </div>
                <div className="join-equals">=</div>
                <div className="join-field">
                  <label>Table B join column</label>
                  <select value={joinColB} onChange={e => setJoinColB(e.target.value)}>
                    <option value="">— select —</option>
                    {bHeaders.map(h => <option key={h}>{h}</option>)}
                  </select>
                </div>
                <div className="join-field join-type-field">
                  <label>Join type</label>
                  <select value={joinType} onChange={e => setJoinType(e.target.value)}>
                    <option value="left">Left (keep all A rows)</option>
                    <option value="inner">Inner (matched only)</option>
                    <option value="full">Full outer (all rows)</option>
                  </select>
                </div>
                <button
                  className="merge-btn"
                  disabled={!aRows.length || !bRows.length || !joinColA || !joinColB}
                  onClick={handleJoin}
                >
                  Run Join ▶
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === "join" && (
        <div className="panel">
          {!merged ? (
            <div className="placeholder">Configure your tables and run a join first.</div>
          ) : (
            <>
              <div className="join-result-bar">
                <div className="join-result-stats">
                  <span className="stat-pill matched">{merged.filter(r => r._status === "✓ matched").length} matched</span>
                  <span className="stat-pill a-only">{merged.filter(r => r._status === "A only").length} A only</span>
                  {joinType === "full" && <span className="stat-pill b-only">{merged.filter(r => r._status === "B only").length} B only</span>}
                </div>
                <div style={{ display: "flex", gap: "0.5rem" }}>
                  <button className="export-btn" onClick={() => exportCSV(filteredMerged, ["_status", ...mergedHeaders], "joined_filtered.csv")}>↓ CSV ({filteredMerged.length})</button>
                  <button className="export-btn secondary" onClick={() => exportXLSX(filteredMerged, ["_status", ...mergedHeaders], "joined_filtered.xlsx")}>↓ XLSX ({filteredMerged.length})</button>
                </div>
              </div>
              <div className="section-title">Filter result</div>
              <FilterBar headers={["_status", ...mergedHeaders]} filters={mergedFilters} onChange={setMergedFilters} />
              <DataTable
                headers={["_status", ...mergedHeaders]}
                rows={filteredMerged}
                caption={`${filteredMerged.length} / ${merged.length} rows`}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Root App ──────────────────────────────────────────────────────────────────

export default function App() {
  const [section, setSection] = useState("datafuse");

  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Syne:wght@400;600;700;800&family=DM+Mono:wght@300;400;500&display=swap');
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
        body { background: #0a0a0f; color: #e8e4dc; font-family: 'DM Mono', monospace; min-height: 100vh; }

        /* NAVBAR */
        .navbar { display: flex; align-items: center; padding: 0 2rem; background: #060609; border-bottom: 1px solid #161622; position: sticky; top: 0; z-index: 100; height: 54px; }
        .navbar-brand { font-family: 'Syne', sans-serif; font-size: 1.15rem; font-weight: 800; background: linear-gradient(135deg, #f0e6c8, #c8a87a); -webkit-background-clip: text; -webkit-text-fill-color: transparent; margin-right: 2.5rem; letter-spacing: -0.02em; white-space: nowrap; }
        .navbar-links { display: flex; gap: 0; flex: 1; height: 100%; }
        .nav-link { display: flex; align-items: center; gap: 0.45rem; padding: 0 1.2rem; height: 100%; background: transparent; border: none; border-bottom: 2px solid transparent; color: #4a4a5e; font-family: 'DM Mono', monospace; font-size: 0.78rem; cursor: pointer; transition: all 0.15s; white-space: nowrap; }
        .nav-link:hover { color: #888; background: #0c0c14; }
        .nav-link.active { color: #c8a87a; border-bottom-color: #c8a87a; background: #0c0c14; }
        .nav-link-icon { font-size: 0.95rem; }
        .nav-badge { background: #c8a87a; color: #0a0a0f; font-size: 0.52rem; font-weight: 700; padding: 0.08rem 0.32rem; border-radius: 100px; font-family: 'Syne', sans-serif; letter-spacing: 0.06em; }

        /* LAYOUT */
        .app { max-width: 1400px; margin: 0 auto; padding: 2rem; }
        .page-header { margin-bottom: 2rem; padding-bottom: 1.5rem; border-bottom: 1px solid #1a1a28; }
        .page-header h1 { font-family: 'Syne', sans-serif; font-size: 1.5rem; font-weight: 800; letter-spacing: -0.02em; background: linear-gradient(135deg, #f0e6c8, #c8a87a); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
        .page-header p { font-size: 0.76rem; color: #44445a; margin-top: 0.3rem; }

        /* TABS */
        .tabs { display: flex; gap: 0; margin-bottom: 2rem; border: 1px solid #1e1e2e; border-radius: 6px; overflow: hidden; width: fit-content; }
        .tab-btn { padding: 0.55rem 1.3rem; background: transparent; border: none; border-right: 1px solid #1e1e2e; color: #555; font-family: 'DM Mono', monospace; font-size: 0.78rem; cursor: pointer; transition: all 0.15s; }
        .tab-btn:last-child { border-right: none; }
        .tab-btn.active { background: #c8a87a; color: #0a0a0f; font-weight: 500; }
        .tab-btn:hover:not(.active) { background: #0e0e1a; color: #aaa; }
        .panel { animation: fadeIn 0.2s ease; }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: none; } }
        .section-title { font-family: 'Syne', sans-serif; font-size: 0.68rem; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #c8a87a; margin-bottom: 0.7rem; }

        /* DROP ZONE */
        .drop-zone { border: 1.5px dashed #222233; border-radius: 8px; padding: 2.5rem; text-align: center; cursor: pointer; transition: all 0.2s; background: #0c0c18; margin-bottom: 1.5rem; }
        .drop-zone.compact { padding: 1.2rem; }
        .drop-zone:hover, .drop-zone.over { border-color: #c8a87a; background: #10101e; }
        .drop-icon { font-size: 1.7rem; margin-bottom: 0.5rem; opacity: 0.45; }
        .drop-label { font-family: 'Syne', sans-serif; font-size: 0.9rem; font-weight: 600; margin-bottom: 0.25rem; }
        .drop-sub { font-size: 0.7rem; color: #44445a; }

        /* CHIPS */
        .file-chips { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-bottom: 1.25rem; }
        .chip { background: #121220; border: 1px solid #1e1e30; border-radius: 100px; padding: 0.2rem 0.7rem; font-size: 0.7rem; color: #777; }

        /* FILTER */
        .filter-bar { display: flex; flex-wrap: wrap; gap: 0.6rem; margin-bottom: 1.25rem; padding: 1rem; background: #0c0c18; border: 1px solid #1a1a28; border-radius: 6px; }
        .filter-item { display: flex; flex-direction: column; gap: 0.22rem; min-width: 110px; flex: 1; }
        .filter-item label { font-size: 0.62rem; letter-spacing: 0.08em; text-transform: uppercase; color: #555; }
        .filter-item input { background: #0a0a0f; border: 1px solid #1e1e2e; border-radius: 4px; padding: 0.32rem 0.6rem; color: #e8e4dc; font-family: 'DM Mono', monospace; font-size: 0.76rem; outline: none; transition: border-color 0.15s; }
        .filter-item input:focus { border-color: #c8a87a55; }

        /* TABLE */
        .table-wrap { background: #08080e; border: 1px solid #1a1a28; border-radius: 8px; overflow: hidden; }
        .table-caption { padding: 0.6rem 1rem; font-size: 0.68rem; letter-spacing: 0.08em; text-transform: uppercase; color: #555; border-bottom: 1px solid #1a1a28; }
        .table-scroll { overflow-x: auto; max-height: 400px; overflow-y: auto; }
        table { width: 100%; border-collapse: collapse; font-size: 0.76rem; }
        th { position: sticky; top: 0; background: #0c0c18; padding: 0.5rem 0.85rem; text-align: left; font-size: 0.65rem; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; color: #c8a87a; border-bottom: 1px solid #1a1a28; white-space: nowrap; }
        td { padding: 0.42rem 0.85rem; border-bottom: 1px solid #0e0e18; color: #a8a4a0; white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
        tr:hover td { background: #0e0e1a; }
        .empty { text-align: center; color: #333; padding: 2rem !important; }
        .row-count { padding: 0.38rem 1rem; font-size: 0.66rem; color: #333; border-top: 1px solid #1a1a28; text-align: right; }

        /* BUTTONS */
        .export-btn { padding: 0.42rem 1rem; background: #c8a87a; color: #0a0a0f; border: none; border-radius: 4px; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 0.73rem; cursor: pointer; letter-spacing: 0.04em; transition: background 0.15s; }
        .export-btn:hover { background: #dfc090; }
        .export-btn.secondary { background: transparent; color: #c8a87a; border: 1px solid #c8a87a55; }
        .export-btn.secondary:hover { background: #c8a87a14; }
        .merge-btn { padding: 0.48rem 1.3rem; background: #c8a87a; color: #0a0a0f; border: none; border-radius: 4px; font-family: 'Syne', sans-serif; font-weight: 700; font-size: 0.78rem; cursor: pointer; transition: background 0.15s; align-self: flex-end; }
        .merge-btn:hover { background: #dfc090; }
        .merge-btn:disabled { background: #1e1e2e; color: #444; cursor: not-allowed; }
        .convert-btn { width: 100%; padding: 0.85rem; background: linear-gradient(135deg, #c8a87a, #a07040); color: #0a0a0f; border: none; border-radius: 6px; font-family: 'Syne', sans-serif; font-weight: 800; font-size: 0.92rem; cursor: pointer; letter-spacing: 0.05em; transition: all 0.2s; margin-bottom: 1.5rem; }
        .convert-btn:hover:not(:disabled) { transform: translateY(-1px); box-shadow: 0 4px 24px #c8a87a33; }
        .convert-btn:disabled { background: #1a1a28; color: #444; cursor: not-allowed; transform: none; box-shadow: none; }
        .spinner { display: inline-block; animation: spin 0.8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }

        /* COMPARE (legacy, keep for safety) */
        .compare-config { background: #0c0c18; border: 1px solid #1a1a28; border-radius: 8px; padding: 1.2rem; margin-bottom: 1.5rem; display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end; }
        .compare-config > div { display: flex; flex-direction: column; gap: 0.28rem; flex: 1; min-width: 170px; }
        .compare-config label { font-size: 0.62rem; letter-spacing: 0.1em; text-transform: uppercase; color: #555; }
        .compare-config select { background: #0a0a0f; border: 1px solid #1e1e2e; border-radius: 4px; padding: 0.38rem 0.65rem; color: #e8e4dc; font-family: 'DM Mono', monospace; font-size: 0.76rem; outline: none; }

        /* TWO-SLOT GRID */
        .slots-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; margin-bottom: 1.5rem; }
        @media (max-width: 900px) { .slots-grid { grid-template-columns: 1fr; } }

        .slot { background: #0c0c18; border: 1px solid #1a1a28; border-radius: 10px; padding: 1.25rem; }
        .slot-header { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 1rem; }
        .slot-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
        .slot-label { font-family: 'Syne', sans-serif; font-size: 0.85rem; font-weight: 700; color: #d0ccc4; flex: 1; }
        .slot-clear { background: transparent; border: 1px solid #2a1a1a; border-radius: 4px; color: #664444; font-family: 'DM Mono', monospace; font-size: 0.65rem; padding: 0.18rem 0.55rem; cursor: pointer; transition: all 0.15s; }
        .slot-clear:hover { color: #e07070; border-color: #5a2a2a; background: #1a0a0a; }
        .slot-meta { font-size: 0.68rem; color: #44445a; margin-bottom: 0.75rem; }

        .chip { background: #121220; border: 1px solid #1e1e30; border-radius: 100px; padding: 0.2rem 0.7rem 0.2rem 0.3rem; font-size: 0.68rem; color: #777; display: inline-flex; align-items: center; gap: 0.35rem; }
        .chip-type { font-size: 0.55rem; font-weight: 700; padding: 0.08rem 0.35rem; border-radius: 100px; letter-spacing: 0.05em; }

        /* JOIN CONFIG PANEL */
        .join-config-panel { background: #0a0a14; border: 1px solid #1e1e32; border-radius: 10px; padding: 1.25rem; }
        .join-config-title { display: flex; align-items: center; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap; }
        .join-config-title > span:first-child { font-family: 'Syne', sans-serif; font-size: 0.82rem; font-weight: 700; color: #c8a87a; }
        .shared-hint { display: flex; align-items: center; gap: 0.4rem; font-size: 0.68rem; color: #44445a; flex-wrap: wrap; }
        .shared-col { background: #1a2218; border: 1px solid #2a3828; border-radius: 4px; padding: 0.1rem 0.45rem; color: #70b870; font-size: 0.65rem; }
        .join-config-row { display: flex; gap: 0.75rem; align-items: flex-end; flex-wrap: wrap; }
        .join-field { display: flex; flex-direction: column; gap: 0.28rem; flex: 1; min-width: 150px; }
        .join-field label { font-size: 0.62rem; letter-spacing: 0.1em; text-transform: uppercase; color: #555; }
        .join-field select { background: #0a0a0f; border: 1px solid #1e1e2e; border-radius: 4px; padding: 0.38rem 0.65rem; color: #e8e4dc; font-family: 'DM Mono', monospace; font-size: 0.76rem; outline: none; transition: border-color 0.15s; }
        .join-field select:focus { border-color: #c8a87a55; }
        .join-type-field { min-width: 200px; }
        .join-equals { font-size: 1.1rem; color: #333; padding-bottom: 0.4rem; align-self: flex-end; flex-shrink: 0; }

        /* JOIN RESULT BAR */
        .join-result-bar { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 0.75rem; margin-bottom: 1.25rem; padding: 0.85rem 1rem; background: #0c0c18; border: 1px solid #1a1a28; border-radius: 8px; }
        .join-result-stats { display: flex; gap: 0.5rem; flex-wrap: wrap; }
        .stat-pill { font-size: 0.7rem; padding: 0.22rem 0.7rem; border-radius: 100px; font-family: 'Syne', sans-serif; font-weight: 600; }
        .stat-pill.matched { background: #1a2e1a; color: #5ab870; border: 1px solid #2a4a2a; }
        .stat-pill.a-only { background: #2a1e0e; color: #c8a87a; border: 1px solid #3a2e1a; }
        .stat-pill.b-only { background: #0e1e2a; color: #7ac8c0; border: 1px solid #1a2e3a; }
        .placeholder { text-align: center; padding: 4rem; color: #2a2a3a; font-size: 0.82rem; }

        /* FORMAT CONVERTER */
        .converter-wrap { animation: fadeIn 0.2s ease; }
        .converter-picker { display: grid; grid-template-columns: 1fr auto 1fr; gap: 1.25rem; align-items: start; margin-bottom: 1.5rem; }
        @media (max-width: 700px) { .converter-picker { grid-template-columns: 1fr; } .picker-arrow { display: none; } }
        .picker-col {}
        .picker-label { font-family: 'Syne', sans-serif; font-size: 0.68rem; font-weight: 700; letter-spacing: 0.15em; text-transform: uppercase; color: #555; margin-bottom: 0.75rem; }
        .format-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem; }
        .fmt-btn { display: flex; flex-direction: column; align-items: center; gap: 0.3rem; padding: 0.7rem 0.4rem; background: #0c0c18; border: 1px solid #1a1a28; border-radius: 8px; cursor: pointer; transition: all 0.15s; color: #555; position: relative; }
        .fmt-btn:hover:not(.active) { background: #101018; border-color: #2a2a38; color: #888; }
        .fmt-btn.active { font-weight: 600; }
        .fmt-btn.external { opacity: 0.55; }
        .fmt-btn.external:hover { opacity: 0.75; }
        .fmt-icon { font-size: 1.3rem; line-height: 1; }
        .fmt-name { font-size: 0.6rem; letter-spacing: 0.03em; text-align: center; line-height: 1.2; }
        .fmt-ext-badge { position: absolute; top: 4px; right: 4px; background: #2a1a0a; color: #a07040; font-size: 0.48rem; padding: 0.05rem 0.28rem; border-radius: 100px; font-family: 'Syne', sans-serif; font-weight: 700; letter-spacing: 0.06em; border: 1px solid #3a2a1a; }
        .picker-arrow { display: flex; align-items: center; justify-content: center; padding-top: 2rem; }
        .arrow-glyph { font-size: 1.6rem; color: #2a2a3a; }
        .conversion-summary { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; padding: 0.85rem 1.1rem; background: #0c0c18; border: 1px solid; border-radius: 8px; margin-bottom: 1.5rem; font-size: 0.88rem; font-family: 'Syne', sans-serif; font-weight: 600; }
        .summary-arrow { color: #333; font-size: 1rem; }
        .summary-badge { font-size: 0.65rem; padding: 0.2rem 0.65rem; border-radius: 100px; margin-left: auto; }
        .summary-badge.ai { background: #1a2a1a; color: #70b870; border: 1px solid #2a4a2a; }
        .summary-badge.ext { background: #2a1a0a; color: #c8a060; border: 1px solid #3a2a1a; }
        .error-box { background: #180a0a; border: 1px solid #3a1515; border-radius: 6px; padding: 1rem; color: #d07070; font-size: 0.78rem; margin-bottom: 1rem; line-height: 1.6; }
        .error-links { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.75rem; }
        .error-links a { background: #1a0a0a; border: 1px solid #3a1515; border-radius: 4px; padding: 0.3rem 0.75rem; color: #c8a87a; font-size: 0.72rem; text-decoration: none; transition: all 0.15s; }
        .error-links a:hover { background: #220e0e; }
        .result-section { animation: fadeIn 0.25s ease; }
        .result-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 1rem; flex-wrap: wrap; gap: 0.5rem; }
        .result-ok { color: #5ab870; font-size: 0.82rem; font-family: 'Syne', sans-serif; font-weight: 600; }
        .conversion-note { background: #0e1a0e; border: 1px solid #1e3020; border-radius: 6px; padding: 0.85rem 1rem; font-size: 0.76rem; color: #7aaa80; line-height: 1.6; margin-bottom: 1rem; }
        .conversion-note strong { color: #90cc96; }
        .conversion-note em { color: #a0c8a6; font-style: normal; font-weight: 500; }
        .text-preview { background: #0c0c18; border: 1px solid #1a1a28; border-radius: 8px; padding: 1.25rem; font-size: 0.76rem; color: #9090a0; line-height: 1.75; max-height: 420px; overflow-y: auto; white-space: pre-wrap; }
        .html-preview { background: #0c0c18; border: 1px solid #1a1a28; border-radius: 8px; padding: 1.25rem; font-size: 0.82rem; color: #b0aaa0; line-height: 1.7; max-height: 420px; overflow-y: auto; }
        .json-preview { background: #0c0c18; border: 1px solid #1a1a28; border-radius: 8px; padding: 1.25rem; font-size: 0.7rem; color: #70b890; line-height: 1.6; max-height: 420px; overflow: auto; }

        @media (max-width: 768px) {
          .navbar { padding: 0 1rem; }
          .app { padding: 1.25rem; }
          .pdf-grid { grid-template-columns: 1fr 1fr; }
        }
        @media (max-width: 480px) {
          .pdf-grid { grid-template-columns: 1fr; }
          .navbar-brand { font-size: 1rem; margin-right: 1rem; }
        }
      `}</style>

      <nav className="navbar">
        <div className="navbar-brand">DataFuse</div>
        <div className="navbar-links">
          <button className={`nav-link ${section === "datafuse" ? "active" : ""}`} onClick={() => setSection("datafuse")}>
            <span className="nav-link-icon">⚙️</span> Data Tools
          </button>
          <button className={`nav-link ${section === "pdf" ? "active" : ""}`} onClick={() => setSection("pdf")}>
            <span className="nav-link-icon">🔄</span> File Converter
            <span className="nav-badge">AI</span>
          </button>
        </div>
      </nav>

      <div className="app">
        {section === "datafuse" && (
          <>
            <div className="page-header">
              <h1>Data Tools</h1>
              <p>Upload CSV or XLS/XLSX files into Table A & B, then join them on any shared column</p>
            </div>
            <DataFuse />
          </>
        )}
        {section === "pdf" && (
          <>
            <div className="page-header">
              <h1>File Converter</h1>
              <p>Choose any format to convert from and to — AI-powered, runs in your browser</p>
            </div>
            <FormatConverter />
          </>
        )}
      </div>
    </>
  );
}
